require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs-extra');
const Docker = require('dockerode');
const docker = new Docker();
const db = require('./database');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const session = require('express-session');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { Client, GatewayIntentBits } = require('discord.js');

const PORT = process.env.PORT || 3000;
const CONTAINERS_DIR = path.join(__dirname, 'containers');
fs.ensureDirSync(CONTAINERS_DIR);

// Discord Bot Client
const discordBot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});
discordBot.login(process.env.DISCORD_BOT_TOKEN);

discordBot.on('ready', () => {
  console.log(`Panel Bot: ${discordBot.user.tag}`);
  // Register slash commands
  discordBot.application.commands.set([
    { name: 'deploy', description: 'Upload & deploy your bot' },
    { name: 'mybots', description: 'List your bots' },
    { name: 'start', description: 'Start a bot', options: [{ type: 3, name: 'botid', description: 'Bot ID', required: true }] },
    { name: 'stop', description: 'Stop a bot', options: [{ type: 3, name: 'botid', description: 'Bot ID', required: true }] },
    { name: 'restart', description: 'Restart a bot', options: [{ type: 3, name: 'botid', description: 'Bot ID', required: true }] },
    { name: 'logs', description: 'View bot logs', options: [{ type: 3, name: 'botid', description: 'Bot ID', required: true }] }
  ]);
});

// Docker helper: create/start/stop containers
async function runBotContainer(userId, botId, token) {
  const botDir = path.join(CONTAINERS_DIR, userId, botId);
  await fs.ensureDir(botDir);
  
  // Dockerfile
  const dockerfile = `
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN if [ -f package.json ]; then npm install; fi
ENV TOKEN=${token}
CMD ["node", "main.js"]
`;
  await fs.writeFile(path.join(botDir, 'Dockerfile'), dockerfile);

  // Build & run
  const stream = await docker.buildImage({ context: botDir, src: ['.'] }, { t: `bot-${botId}` });
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve());
  });

  const container = await docker.createContainer({
    Image: `bot-${botId}`,
    name: `bot-${botId}`,
    Tty: true,
    AttachStdout: true,
    AttachStderr: true,
    Env: [`TOKEN=${token}`],
    HostConfig: {
      Memory: 200 * 1024 * 1024, // 200MB
      CpuQuota: 20000, // 20%
      NetworkMode: 'bridge'
    }
  });
  await container.start();
  
  db.prepare('UPDATE bots SET container_id = ?, status = ? WHERE id = ?')
    .run(container.id, 'running', botId);
  return container;
}

async function stopContainer(botId) {
  const row = db.prepare('SELECT container_id FROM bots WHERE id = ?').get(botId);
  if (!row?.container_id) return;
  try {
    const container = docker.getContainer(row.container_id);
    await container.stop();
    await container.remove();
  } catch {}
  db.prepare('UPDATE bots SET container_id = NULL, status = ? WHERE id = ?').run('stopped', botId);
}

// Auth
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_REDIRECT_URI,
  scope: ['identify']
}, async (accessToken, refreshToken, profile, done) => {
  db.prepare('REPLACE INTO users (id, username, avatar) VALUES (?, ?, ?)')
    .run(profile.id, profile.username, profile.avatar);
  return done(null, profile);
}));
passport.serializeUser(u => u.id);
passport.deserializeUser(async id => ({ id }));

app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');

// Routes
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { successRedirect: '/dashboard', failureRedirect: '/login' }));
app.get('/login', (req, res) => res.render('pages/login'));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/login')));

function checkAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', checkAuth, (req, res) => {
  const bots = db.prepare('SELECT * FROM bots WHERE user_id = ?').all(req.user.id);
  res.render('pages/dashboard', { user: req.user, bots });
});

app.get('/bot/:id', checkAuth, (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.redirect('/dashboard');
  res.render('pages/bot', { user: req.user, bot });
});

app.post('/bot/:id/save', checkAuth, async (req, res) => {
  const { content, filename } = req.body;
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.redirect('/dashboard');
  await fs.writeFile(path.join(CONTAINERS_DIR, req.user.id, req.params.id, filename), content);
  res.redirect(`/bot/${req.params.id}`);
});

app.post('/bot/:id/setenv', checkAuth, async (req, res) => {
  const { token } = req.body;
  db.prepare('UPDATE bots SET token = ? WHERE id = ? AND user_id = ?').run(token || null, req.params.id, req.user.id);
  res.redirect(`/bot/${req.params.id}`);
});

app.post('/bot/:id/:action', checkAuth, async (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!bot) return res.redirect('/dashboard');
  const botDir = path.join(CONTAINERS_DIR, req.user.id, req.params.id);
  
  if (req.params.action === 'start') {
    if (bot.token) await runBotContainer(req.user.id, req.params.id, bot.token);
  } else if (req.params.action === 'stop') {
    await stopContainer(req.params.id);
  } else if (req.params.action === 'restart') {
    await stopContainer(req.params.id);
    if (bot.token) await runBotContainer(req.user.id, req.params.id, bot.token);
  } else if (req.params.action === 'delete') {
    await stopContainer(req.params.id);
    await fs.remove(botDir);
    db.prepare('DELETE FROM bots WHERE id = ?').run(req.params.id);
  }
  res.redirect(`/bot/${req.params.id}`);
});

// Discord Slash Commands
discordBot.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'deploy') {
    await interaction.deferReply();
    const userId = interaction.user.id;
    const botId = uuidv4();
    const botDir = path.join(CONTAINERS_DIR, userId, botId);
    await fs.ensureDir(botDir);

    // Use dummy if no file attached
    const dummyCode = `const { Client } = require('discord.js');
const client = new Client({ intents: 32767 });
client.on('ready', () => console.log(\`Dummy \${client.user.tag} hosted successfully!\`));
client.login(process.env.TOKEN);`;
    
    await fs.writeFile(path.join(botDir, 'main.js'), dummyCode);
    db.prepare('INSERT INTO bots (id, user_id, name) VALUES (?, ?, ?)')
      .run(botId, userId, `Bot-${botId.slice(0, 6)}`);
    
    interaction.editReply(`✅ Bot created! ID: \`${botId}\`\nVisit: https://your-panel.com/bot/${botId} to set token & start.`);
  }

  if (interaction.commandName === 'mybots') {
    const bots = db.prepare('SELECT * FROM bots WHERE user_id = ?').all(interaction.user.id);
    interaction.reply(bots.length ? bots.map(b => `\`${b.id}\` — ${b.name} — ${b.status}`).join('\n') : 'No bots yet. Use `/deploy` to start!');
  }

  if (['start','stop','restart','logs'].includes(interaction.commandName)) {
    const botId = interaction.options.getString('botid');
    const row = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(botId, interaction.user.id);
    if (!row) return interaction.reply('❌ Bot not found', { ephemeral: true });
    
    if (interaction.commandName === 'start') {
      if (!row.token) return interaction.reply('❌ Set token on panel first!', { ephemeral: true });
      await runBotContainer(interaction.user.id, botId, row.token);
      interaction.reply('▶️ Starting...');
    } else if (interaction.commandName === 'stop') {
      await stopContainer(botId);
      interaction.reply('⏹️ Stopped');
    } else if (interaction.commandName === 'restart') {
      await stopContainer(botId);
      if (row.token) await runBotContainer(interaction.user.id, botId, row.token);
      interaction.reply('🔄 Restarting...');
    } else if (interaction.commandName === 'logs') {
      interaction.reply('📋 Logs available on web panel');
    }
  }
});

http.listen(PORT, () => console.log(`🚀 Running on port ${PORT}`));
  
