// src/index.js

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
  REST,
  Routes,
  ActivityType,
} = require('discord.js');

const fs   = require('fs');
const path = require('path');
const db   = require('./database');
const { awardXp } = require('./utils/xpHandler');

// ─── Client Setup ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ─── Commands ─────────────────────────────────────────────────────────────────

client.commands    = new Collection();
client.activeDuels = new Map(); // channelId → word duel gameState
client.activeGames = new Map(); // channelId → reaction-race / scramble / number-snipe

const commandsDir  = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));
const commandData  = [];

for (const file of commandFiles) {
  const command = require(path.join(commandsDir, file));
  client.commands.set(command.data.name, command);
  commandData.push(command.data.toJSON());
}

// Grab module-level helpers
const duelModule    = require('./commands/duel');
const scrambleMod   = require('./commands/scramble');

// ─── Message XP Cooldown ──────────────────────────────────────────────────────

const messageCooldowns = new Map();

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅  Logged in as ${readyClient.user.tag}`);

  readyClient.user.setActivity('games & duels ⚔️', { type: ActivityType.Watching });

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commandData });
    console.log(`✅  Registered ${commandData.length} slash command(s) globally.`);
  } catch (err) {
    console.error('❌  Failed to register slash commands:', err);
  }

  const sessions = db.getAllVoiceSessions();
  if (sessions.length) console.log(`🔄  Restoring ${sessions.length} voice session(s).`);

  setInterval(voiceTick, 60_000);
});

// ─── Interaction Handler ──────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (err) {
    console.error(`[Command: ${interaction.commandName}]`, err);
    const msg = { content: '❌ An error occurred.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.member) return;

  const channelId = message.channel.id;
  const userId    = message.author.id;
  const content   = message.content.trim();

  // ── 1. Word Duel (takes highest priority) ──────────────────────────────
  const duelState = client.activeDuels.get(channelId);
  if (duelState && duelState.active) {
    const word = content.toLowerCase();

    if (/^[a-z]+$/.test(word)) {
      const result = duelModule.handleDuelWord(duelState, userId, word);

      if (result === 'valid') {
        await message.react('✅').catch(() => {});

        if (duelState.gameMsg) {
          const chalScore  = duelState.scores[duelState.challenger] || 0;
          const oppScore   = duelState.scores[duelState.opponent]   || 0;
          const chalWords  = duelState.wordCounts[duelState.challenger] || 0;
          const oppWords   = duelState.wordCounts[duelState.opponent]   || 0;
          const elapsed    = Date.now() - duelState.startedAt;
          const remaining  = Math.max(0, Math.round((30000 - elapsed) / 1000));
          const letterDisp = duelState.letters.map(l => `**${l.toUpperCase()}**`).join('  ');

          duelState.gameMsg.edit({
            embeds: [{
              color: 0x5B8FFF,
              title: '🔤 Word Duel — IN PROGRESS',
              description: `**Your letters:**\n\n${letterDisp}\n\n⏱️ **${remaining}s remaining**`,
              fields: [
                { name: '🗡️ Challenger', value: `<@${duelState.challenger}>\n${chalWords} words · **${chalScore} pts**`, inline: true },
                { name: '🛡️ Opponent',   value: `<@${duelState.opponent}>\n${oppWords} words · **${oppScore} pts**`,     inline: true },
              ],
              footer: { text: `⚔️ Wager: ${duelState.wager.toLocaleString()} XP · Last: "${word}" (+${word.length} pts)` },
              timestamp: new Date().toISOString(),
            }],
          }).catch(() => {});
        }

      } else if (result === 'already_claimed') {
        await message.react('❌').catch(() => {});
      } else if (result === 'invalid' && (userId === duelState.challenger || userId === duelState.opponent)) {
        await message.react('🚫').catch(() => {});
      }
    }
    return; // never award XP during a word duel
  }

  // ── 2. Active Game in channel (reaction race / scramble) ───────────────
  const gameState = client.activeGames.get(channelId);
  if (gameState && gameState.active) {

    // ── Reaction Race ─────────────────────────────────────────────────
    if (gameState.type === 'reaction-race') {
      // Compare raw content (emojis) to the sequence
      const typed = content;
      if (typed === gameState.sequence) {
        gameState.active = false;
        client.activeGames.delete(channelId);

        const member = message.member;
        db.addXp(userId, message.guild.id, gameState.reward);

        await message.react('⚡').catch(() => {});
        await message.channel.send({
          embeds: [
            {
              color: 0xFFD700,
              title: '⚡ Reaction Race — Winner!',
              description:
                `🏆 **${member.displayName}** typed it first and wins **${gameState.reward.toLocaleString()} XP**!\n\n` +
                `The sequence was: ${gameState.sequence}`,
              timestamp: new Date().toISOString(),
            },
          ],
        }).catch(() => {});
      }
      return; // don't award normal XP during race
    }

    // ── Scramble ──────────────────────────────────────────────────────
    if (gameState.type === 'scramble-solo' || gameState.type === 'scramble-duel') {
      await scrambleMod.handleScrambleMessage(gameState, userId, content, message.channel, client);
      return; // don't award normal XP during scramble
    }

    return;
  }

  // ── 3. Normal message XP ───────────────────────────────────────────────
  const config = db.getGuildConfig(message.guild.id);
  const key    = `${userId}-${message.guild.id}`;
  const now    = Date.now();
  const last   = messageCooldowns.get(key) ?? 0;

  if (now - last < config.message_cooldown_ms) return;
  messageCooldowns.set(key, now);

  const xpAmount = randomInt(config.message_xp_min, config.message_xp_max);
  await awardXp(message.member, xpAmount, message.channel);
});

// ─── Voice State XP ───────────────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const userId     = newState.id;
  const guildId    = newState.guild.id;
  const wasInVoice = !!oldState.channelId;
  const isInVoice  = !!newState.channelId;
  const afkId      = newState.guild.afkChannelId;

  if (!wasInVoice && isInVoice) {
    if (!isMuted(newState) && newState.channelId !== afkId) db.startVoiceSession(userId, guildId);
    return;
  }
  if (wasInVoice && !isInVoice) { db.endVoiceSession(userId, guildId); return; }
  if (wasInVoice && isInVoice) {
    const wasOk = !isMuted(oldState) && oldState.channelId !== afkId;
    const isOk  = !isMuted(newState) && newState.channelId !== afkId;
    if (wasOk && !isOk)  db.endVoiceSession(userId, guildId);
    if (!wasOk && isOk)  db.startVoiceSession(userId, guildId);
  }
});

// ─── Voice XP Ticker ──────────────────────────────────────────────────────────

async function voiceTick() {
  const sessions = db.getAllVoiceSessions();
  for (const session of sessions) {
    try {
      const guild = client.guilds.cache.get(session.guild_id);
      if (!guild) continue;
      const config = db.getGuildConfig(session.guild_id);
      const member = await guild.members.fetch(session.user_id).catch(() => null);
      if (!member) { db.endVoiceSession(session.user_id, session.guild_id); continue; }
      const vs = member.voice;
      if (!vs.channelId || isMuted(vs) || vs.channelId === guild.afkChannelId) {
        db.endVoiceSession(session.user_id, session.guild_id);
        continue;
      }
      await awardXp(member, config.voice_xp_per_min, null);
    } catch (err) {
      console.error('[Voice Tick]', err);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function isMuted(vs) { return vs.selfMute || vs.selfDeaf || vs.serverMute || vs.serverDeaf; }

// ─── Login ────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token) { console.error('❌  DISCORD_TOKEN not set.'); process.exit(1); }
client.login(token);