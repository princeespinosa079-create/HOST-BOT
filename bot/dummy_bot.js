const { Client } = require('discord.js');
const client = new Client({ intents: 32767 });

client.on('ready', () => {
  console.log(`✅ Dummy ${client.user.tag} hosted successfully!`);
});

client.login(process.env.TOKEN);
