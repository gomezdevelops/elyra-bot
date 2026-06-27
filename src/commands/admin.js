// src/commands/admin.js
// Comprehensive admin command for server managers.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const db = require('../database');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('⚙️ Admin tools for managing the leveling system.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    // ── XP management ──────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('set-xp')
        .setDescription('Set a user\'s total XP directly.')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(o => o.setName('xp').setDescription('XP amount').setMinValue(0).setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('add-xp')
        .setDescription('Add XP to a user.')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(o => o.setName('xp').setDescription('XP to add').setMinValue(1).setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove-xp')
        .setDescription('Remove XP from a user.')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
        .addIntegerOption(o => o.setName('xp').setDescription('XP to remove').setMinValue(1).setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('reset')
        .setDescription('Reset a user\'s XP, level, and stats completely.')
        .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
    )

    // ── Server settings ────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('set-levelup-channel')
        .setDescription('Set the channel where level-up announcements are sent.')
        .addChannelOption(o => o.setName('channel').setDescription('Announcement channel (leave blank to disable)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('set-achievements-channel')
        .setDescription('Set the channel where achievement unlock announcements are sent.')
        .addChannelOption(o => o.setName('channel').setDescription('Achievements channel (leave blank to disable)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('set-multiplier')
        .setDescription('Set the XP multiplier for this server (e.g. 2.0 = double XP).')
        .addNumberOption(o =>
          o.setName('multiplier').setDescription('XP multiplier (0.1–10.0)').setMinValue(0.1).setMaxValue(10).setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('set-message-xp')
        .setDescription('Configure message XP range and cooldown.')
        .addIntegerOption(o => o.setName('min').setDescription('Min XP per message').setMinValue(1).setRequired(true))
        .addIntegerOption(o => o.setName('max').setDescription('Max XP per message').setMinValue(1).setRequired(true))
        .addIntegerOption(o => o.setName('cooldown').setDescription('Cooldown in seconds (default 60)').setMinValue(5).setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('set-voice-xp')
        .setDescription('Configure voice XP per minute.')
        .addIntegerOption(o => o.setName('xp').setDescription('XP per minute in voice').setMinValue(1).setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('settings')
        .setDescription('View current server configuration.')
    )

    // ── Shop management ────────────────────────────────────────────────────
    .addSubcommand(sub =>
      sub.setName('shop-add')
        .setDescription('Add a title item to the shop.')
        .addStringOption(o => o.setName('name').setDescription('Item name').setRequired(true))
        .addIntegerOption(o => o.setName('cost').setDescription('XP cost').setMinValue(1).setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('The title text users will receive').setRequired(true))
        .addStringOption(o => o.setName('description').setDescription('Item description').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('shop-remove')
        .setDescription('Remove an item from the shop.')
        .addIntegerOption(o => o.setName('id').setDescription('Item ID').setMinValue(1).setRequired(true))
    ),

  async execute(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ You need **Manage Server** permission.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // ── SET XP ──────────────────────────────────────────────────────────────
    if (sub === 'set-xp') {
      const target = interaction.options.getUser('user');
      const xp     = interaction.options.getInteger('xp');
      const { oldLevel, newLevel } = db.setXp(target.id, guildId, xp);

      return interaction.editReply({
        embeds: [successEmbed(
          'XP Set',
          `Set **${target.displayName}**'s XP to **${xp.toLocaleString()}** (Level ${newLevel})` +
          (newLevel !== oldLevel ? ` — was Level ${oldLevel}` : '')
        )],
      });
    }

    // ── ADD XP ──────────────────────────────────────────────────────────────
    if (sub === 'add-xp') {
      const target = interaction.options.getUser('user');
      const xp     = interaction.options.getInteger('xp');
      const { oldLevel, newLevel, totalXp } = db.addXp(target.id, guildId, xp);

      return interaction.editReply({
        embeds: [successEmbed(
          'XP Added',
          `Added **${xp.toLocaleString()} XP** to **${target.displayName}**.\nNew total: **${totalXp.toLocaleString()} XP** (Level ${newLevel})` +
          (newLevel > oldLevel ? ` — leveled up from ${oldLevel}!` : '')
        )],
      });
    }

    // ── REMOVE XP ───────────────────────────────────────────────────────────
    if (sub === 'remove-xp') {
      const target   = interaction.options.getUser('user');
      const xp       = interaction.options.getInteger('xp');
      const userData = db.getUser(target.id, guildId);
      const newXp    = Math.max(0, userData.xp - xp);
      const { newLevel } = db.setXp(target.id, guildId, newXp);

      return interaction.editReply({
        embeds: [successEmbed(
          'XP Removed',
          `Removed **${xp.toLocaleString()} XP** from **${target.displayName}**.\nNew total: **${newXp.toLocaleString()} XP** (Level ${newLevel})`
        )],
      });
    }

    // ── RESET ────────────────────────────────────────────────────────────────
    if (sub === 'reset') {
      const target = interaction.options.getUser('user');
      db.resetUser(target.id, guildId);

      return interaction.editReply({
        embeds: [successEmbed('User Reset', `**${target.displayName}**'s XP, level, and stats have been reset to zero.`)],
      });
    }

    // ── SET LEVELUP CHANNEL ─────────────────────────────────────────────────
    if (sub === 'set-levelup-channel') {
      const channel = interaction.options.getChannel('channel');
      db.setGuildConfig(guildId, { levelup_channel_id: channel?.id ?? null });

      return interaction.editReply({
        embeds: [successEmbed(
          'Level-Up Channel Updated',
          channel
            ? `Level-up announcements will be sent to ${channel}.`
            : 'Level-up announcements will now appear in the channel where the user chatted.'
        )],
      });
    }

    // ── SET ACHIEVEMENTS CHANNEL ─────────────────────────────────────────────
    if (sub === 'set-achievements-channel') {
      const channel = interaction.options.getChannel('channel');
      db.setGuildConfig(guildId, { achievements_channel_id: channel?.id ?? null });

      return interaction.editReply({
        embeds: [successEmbed(
          'Achievements Channel Updated',
          channel
            ? `Achievement unlock announcements will now be sent only to ${channel}.`
            : 'Achievement announcements will now appear in whichever channel triggered the unlock.'
        )],
      });
    }

    // ── SET MULTIPLIER ──────────────────────────────────────────────────────
    if (sub === 'set-multiplier') {
      const mult = interaction.options.getNumber('multiplier');
      db.setGuildConfig(guildId, { xp_multiplier: mult });

      return interaction.editReply({
        embeds: [successEmbed('XP Multiplier Set', `All XP gains are now multiplied by **×${mult}**.`)],
      });
    }

    // ── SET MESSAGE XP ──────────────────────────────────────────────────────
    if (sub === 'set-message-xp') {
      const min      = interaction.options.getInteger('min');
      const max      = interaction.options.getInteger('max');
      const cooldown = interaction.options.getInteger('cooldown');

      if (min > max) {
        return interaction.editReply({ embeds: [errorEmbed('Min XP cannot be greater than max XP.')] });
      }

      const updates = { message_xp_min: min, message_xp_max: max };
      if (cooldown) updates.message_cooldown_ms = cooldown * 1000;
      db.setGuildConfig(guildId, updates);

      return interaction.editReply({
        embeds: [successEmbed(
          'Message XP Updated',
          `Messages now award **${min}–${max} XP** with a **${(updates.message_cooldown_ms ?? 60_000) / 1000}s** cooldown.`
        )],
      });
    }

    // ── SET VOICE XP ────────────────────────────────────────────────────────
    if (sub === 'set-voice-xp') {
      const xp = interaction.options.getInteger('xp');
      db.setGuildConfig(guildId, { voice_xp_per_min: xp });

      return interaction.editReply({
        embeds: [successEmbed('Voice XP Updated', `Voice channels now award **${xp} XP/minute**.`)],
      });
    }

    // ── SETTINGS ────────────────────────────────────────────────────────────
    if (sub === 'settings') {
      const config = db.getGuildConfig(guildId);

      const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(`⚙️ Server Settings — ${interaction.guild.name}`)
        .addFields(
          {
            name: '📢 Level-Up Channel',
            value: config.levelup_channel_id ? `<#${config.levelup_channel_id}>` : 'Same channel as message',
            inline: true,
          },
          {
            name: '🎖️ Achievements Channel',
            value: config.achievements_channel_id ? `<#${config.achievements_channel_id}>` : 'Same channel as trigger',
            inline: true,
          },
          { name: '✨ XP Multiplier',   value: `×${config.xp_multiplier}`,                              inline: true },
          { name: '💬 Message XP',       value: `${config.message_xp_min}–${config.message_xp_max} XP`,  inline: true },
          { name: '⏱️ Message Cooldown', value: `${config.message_cooldown_ms / 1000}s`,                 inline: true },
          { name: '🎙️ Voice XP/min',    value: `${config.voice_xp_per_min} XP`,                         inline: true },
          { name: '⚔️ Duel Cooldown',   value: `${config.duel_cooldown_ms / 1000}s`,                    inline: true },
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── SHOP ADD ─────────────────────────────────────────────────────────────
    if (sub === 'shop-add') {
      const name  = interaction.options.getString('name');
      const cost  = interaction.options.getInteger('cost');
      const title = interaction.options.getString('title');
      const desc  = interaction.options.getString('description') ?? '';

      db.addShopItem(guildId, name, desc, cost, 'title', title);

      return interaction.editReply({
        embeds: [successEmbed('Shop Item Added', `Added **${name}** (title: *"${title}"*) for **${cost.toLocaleString()} XP**.`)],
      });
    }

    // ── SHOP REMOVE ──────────────────────────────────────────────────────────
    if (sub === 'shop-remove') {
      const itemId  = interaction.options.getInteger('id');
      const removed = db.removeShopItem(itemId, guildId);

      if (!removed) {
        return interaction.editReply({ embeds: [errorEmbed(`No shop item with ID **${itemId}** found.`)] });
      }

      return interaction.editReply({
        embeds: [successEmbed('Shop Item Removed', `Item #${itemId} has been removed from the shop.`)],
      });
    }
  },
};

function successEmbed(title, desc) {
  return new EmbedBuilder().setColor(0x2ECC71).setTitle(`✅ ${title}`).setDescription(desc).setTimestamp();
}
function errorEmbed(desc) {
  return new EmbedBuilder().setColor(0xE74C3C).setTitle('❌ Error').setDescription(desc).setTimestamp();
}