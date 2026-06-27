// src/utils/xpHandler.js
// Centralised logic for awarding XP, detecting level-ups, and granting role rewards.

const { EmbedBuilder } = require('discord.js');
const db = require('../database');
const { checkAndUnlock, TIER_COLORS } = require('./achievements');

/**
 * Award XP to a guild member, handle level-ups, role rewards, and achievements.
 *
 * @param {GuildMember} member        - The Discord.js GuildMember
 * @param {number}      amount        - XP amount to add
 * @param {TextChannel|null} channel  - Channel to send level-up message (null = suppress)
 */
async function awardXp(member, amount, channel = null) {
  const { oldLevel, newLevel, totalXp } = db.addXp(member.id, member.guild.id, amount);

  // ── Achievement check (runs on every XP change, level-up or not) ───────────
  const newlyUnlocked = checkAndUnlock(member.id, member.guild.id);
  if (newlyUnlocked.length) {
    const announceChannel = channel || resolveLevelupChannel(member);
    if (announceChannel) {
      for (const ach of newlyUnlocked) {
        announceChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(TIER_COLORS[ach.tier] || 0xFFD700)
              .setTitle('🎖️ Achievement Unlocked!')
              .setDescription(`${member} just unlocked **${ach.emoji} ${ach.name}**!\n*${ach.desc}*`)
              .setFooter({ text: `${ach.tier} Tier · Use /achievements to see all` })
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    }
  }

  if (newLevel <= oldLevel) return; // No level-up — achievements already handled above

  // ── Determine announcement channel ────────────────────────────────────────
  let announceChannel = channel || resolveLevelupChannel(member);

  // ── Level-Up Message ──────────────────────────────────────────────────────
  if (announceChannel) {
    const { current, needed } = db.getProgress(totalXp, newLevel);
    const bar = db.buildProgressBar(current, needed, 18);
    const pct = Math.floor((current / needed) * 100);

    const embed = new EmbedBuilder()
      .setColor(getLevelColor(newLevel))
      .setTitle('🎉 Level Up!')
      .setDescription(`${member} just reached **Level ${newLevel}**! Keep it up!`)
      .addFields(
        { name: '⭐ New Level', value: `**${newLevel}**`, inline: true },
        { name: '✨ Total XP', value: `**${totalXp.toLocaleString()}**`, inline: true },
        { name: '\u200b', value: '\u200b', inline: true },
        {
          name: `Progress to Level ${newLevel + 1} — ${pct}%`,
          value: `\`${bar}\`\n**${current.toLocaleString()} / ${needed.toLocaleString()} XP**`,
        }
      )
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setTimestamp();

    announceChannel.send({ embeds: [embed] }).catch(() => {});
  }

  // ── Role Rewards ──────────────────────────────────────────────────────────
  for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
    const reward = db.getRoleRewardForLevel(member.guild.id, lvl);
    if (!reward) continue;

    try {
      const role = await member.guild.roles.fetch(reward.role_id);
      if (!role) continue;

      const botMember = member.guild.members.me;
      if (role.position >= botMember.roles.highest.position) {
        console.warn(`[XP] Cannot assign role "${role.name}" — bot role too low.`);
        if (announceChannel) {
          announceChannel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xE74C3C)
                .setTitle('⚠️ Role Assignment Failed')
                .setDescription(
                  `${member} earned **${role.name}** for Level ${lvl}, but I can't assign it.\n` +
                  'An admin must move my role above it.'
                ),
            ],
          }).catch(() => {});
        }
        continue;
      }

      await member.roles.add(role, `Level ${lvl} reward`);

      if (announceChannel) {
        announceChannel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x9B59B6)
              .setTitle('🎖️ Role Reward Unlocked!')
              .setDescription(
                `${member} has been awarded the ${role} role for reaching **Level ${lvl}**!`
              )
              .setTimestamp(),
          ],
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`[XP] Error assigning role for level ${lvl}:`, err);
    }
  }
}

function resolveLevelupChannel(member) {
  const config = db.getGuildConfig(member.guild.id);
  if (config.levelup_channel_id) {
    return member.guild.channels.cache.get(config.levelup_channel_id) || null;
  }
  return null;
}

function getLevelColor(level) {
  if (level >= 50) return 0xFF0000; // Red — legendary
  if (level >= 30) return 0xFFD700; // Gold
  if (level >= 20) return 0xFF8C00; // Orange
  if (level >= 10) return 0x9B59B6; // Purple
  if (level >= 5)  return 0x2ECC71; // Green
  return 0x3498DB;                  // Blue
}

module.exports = { awardXp, getLevelColor };