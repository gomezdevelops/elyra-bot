// src/deploy-commands.js
// Run with: node src/deploy-commands.js
// Registers slash commands globally or to a guild (set GUILD_ID in .env for instant testing).

require('dotenv').config();

const { REST, Routes } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId  = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('❌  DISCORD_TOKEN and CLIENT_ID must be set in your .env file.');
  process.exit(1);
}

const commands = [];
const commandsDir = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
  const { data } = require(path.join(commandsDir, file));
  const json = data.toJSON();

  console.log(
    json.name,
    json.options?.map(o => ({
      name: o.name,
      type: o.type
    }))
  );

  commands.push(json);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`🔄  Deploying ${commands.length} slash command(s)...`);

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log(`✅  Commands deployed to guild ${guildId} (instant).`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      console.log('✅  Commands deployed globally (may take up to 1 hour to propagate).');
    }
  } catch (err) {
    console.error('❌  Deployment failed:', err);
  }
})();