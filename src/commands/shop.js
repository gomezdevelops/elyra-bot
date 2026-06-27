// src/commands/shop.js
// XP shop — browse and buy items (titles, perks) with earned XP.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { checkAndUnlock, TIER_COLORS } = require('../utils/achievements');
const { resolveAchievementsChannel } = require('../utils/xpHandler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Browse and buy items with your XP.')
    .addSubcommand(sub =>
      sub.setName('browse').setDescription('Browse available items in the shop.')
    )
    .addSubcommand(sub =>
      sub
        .setName('buy')
        .setDescription('Purchase an item from the shop.')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Item ID from /shop browse').setRequired(true).setMinValue(1)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const userId  = interaction.user.id;

    // ── BROWSE ──────────────────────────────────────────────────────────────
    if (sub === 'browse') {
      const items = db.getShopItems(guildId);

      if (!items.length) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x95A5A6)
              .setTitle('🏪 XP Shop')
              .setDescription('The shop is currently empty. Admins can add items with `/admin shop-add`.')
              .setTimestamp(),
          ],
        });
      }

      const userData = db.getUser(userId, guildId);
      const lines = items.map(item =>
        `\`#${item.id}\` **${item.name}** — ${item.cost.toLocaleString()} XP\n` +
        `　*${item.description || 'No description.'}* (${item.item_type})`
      );

      const embed = new EmbedBuilder()
        .setColor(0xF39C12)
        .setTitle('🏪 XP Shop')
        .setDescription(lines.join('\n\n'))
        .setFooter({
          text: `Your XP: ${userData.xp.toLocaleString()} · Use /shop buy <id> to purchase`,
        })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── BUY ─────────────────────────────────────────────────────────────────
    if (sub === 'buy') {
      const itemId = interaction.options.getInteger('id');
      const result = db.buyShopItem(userId, guildId, itemId);

      if (!result.success) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(0xE74C3C)
              .setTitle('❌ Purchase Failed')
              .setDescription(result.reason)
              .setTimestamp(),
          ],
        });
      }

      const { item, newXp } = result;

      // Check for newly unlocked achievements (e.g. "first_title")
      const newlyUnlocked = checkAndUnlock(userId, guildId);

      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('✅ Purchase Successful!')
            .setDescription(
              `You bought **${item.name}** for **${item.cost.toLocaleString()} XP**!` +
              (item.item_type === 'title' ? `\n\nYour new title: *"${item.item_value}"*` : '')
            )
            .addFields({ name: 'Remaining XP', value: `**${newXp.toLocaleString()}**`, inline: true })
            .setTimestamp(),
        ],
      });

      // Send achievement unlock(s) to the dedicated achievements channel (falls back to current channel)
      if (newlyUnlocked.length) {
        const achChannel = resolveAchievementsChannel(interaction.member) || interaction.channel;
        for (const ach of newlyUnlocked) {
          achChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(TIER_COLORS[ach.tier] || 0xFFD700)
                .setTitle('🎖️ Achievement Unlocked!')
                .setDescription(`<@${userId}> just unlocked **${ach.emoji} ${ach.name}**!\n*${ach.desc}*`)
                .setFooter({ text: `${ach.tier} Tier · Use /achievements to see all` })
                .setTimestamp(),
            ],
          }).catch(() => {});
        }
      }
      return;
    }
  },
};