/**
 * Proximity Voice Chat — Discord Bot
 * discord.js v14 | Node.js
 *
 * Получает координаты игроков от MCBE аддона (HTTP POST)
 * Мутит/анмутит участников голосового канала по дистанции
 */

require('dotenv').config();
const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const {
    Client, GatewayIntentBits,
    REST, Routes, SlashCommandBuilder,
    PermissionFlagsBits
} = require('discord.js');
const { calcMutes } = require('./proximityLogic');

// ══ Пути к файлам БД ══════════════════════════════════════════
const DB_FILE   = path.join(__dirname, 'data', 'players.json');
const BANS_FILE = path.join(__dirname, 'data', 'bans.json');

// Создаём папку data если нет
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'));
}

// ══ Загрузка/сохранение БД ════════════════════════════════════

/** Структура players.json:
 * {
 *   "voiceId123": {
 *     "discordId": "123456789",
 *     "mcName":    "Steve",
 *     "linked":    true,
 *     "voiceOff":  false   // игрок отключил себя через /voice:vc off
 *   }
 * }
 */
function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (_) {}
    return {};
}
function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/** Структура bans.json:
 * { "voiceId123": true, ... }
 */
function loadBans() {
    try {
        if (fs.existsSync(BANS_FILE)) return JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'));
    } catch (_) {}
    return {};
}
function saveBans(bans) {
    fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2));
}

// ══ Discord Client ═════════════════════════════════════════════
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
    partials: ['CHANNEL'] // нужно для получения ЛС
});

// ══ Мут-состояния (чтобы не дёргать Discord лишний раз) ═══════
// Map<discordId, boolean> — true = сейчас замучен нами
const muteState = new Map();

// ══ Трекинг "не в войс-канале" ════════════════════════════════
// Чтобы не спамить уведомлениями каждые 2 сек — пишем раз в N минут
// Map<discordId, timestamp> — когда последний раз отправляли напоминание
const lastNotified = new Map();
const NOTIFY_COOLDOWN_MS = 3 * 60 * 1000; // 3 минуты между напоминаниями

// ══ Регистрация slash-команд ═══════════════════════════════════
const commands = [
    // /vc link — привязать через DM уже не нужна, но оставим info
    new SlashCommandBuilder()
        .setName('vc')
        .setDescription('Proximity Voice Chat управление')
        .addSubcommand(sub =>
            sub.setName('info')
               .setDescription('Показать свой голосовой ID и статус привязки')
        ),
].map(c => c.toJSON());

// ══ Обработка ЛС от игроков (привязка) ════════════════════════
client.on('messageCreate', async msg => {
    if (!msg.guild && !msg.author.bot) {
        // Это ЛС
        const content = msg.content.trim();

        // Ожидаем что игрок прислал свой voiceId
        // Формат: просто "id4993932" или "id23hsa"
        if (/^id[a-z0-9]+$/i.test(content)) {
            const voiceId = content.toLowerCase();
            const db      = loadDB();
            const bans    = loadBans();

            // Проверяем: существует ли такой ID в базе
            if (!db[voiceId]) {
                return msg.reply('❌ Такой ID не найден. Проверь правильность или сбрось через `/voice:vc re` в игре.');
            }

            // Проверяем бан
            if (bans[voiceId]) {
                return msg.reply('🚫 Ты забанен в Proximity Voice Chat. Обратись к администратору.');
            }

            // Проверяем: не привязан ли этот ID уже к другому Discord
            const existingEntry = Object.values(db).find(e => e.discordId === msg.author.id);
            if (existingEntry) {
                return msg.reply('⚠️ Твой Discord уже привязан к другому MC-аккаунту. Сначала сбрось ID через `/voice:vc re` в игре.');
            }

            // Привязываем
            db[voiceId].discordId = msg.author.id;
            db[voiceId].linked    = true;
            saveDB(db);

            console.log(`[Link] ${db[voiceId].mcName} (${voiceId}) → Discord ${msg.author.id}`);
            return msg.reply(
                `✅ **Успешно привязано!**\n` +
                `🎮 Minecraft: **${db[voiceId].mcName}**\n` +
                `🆔 Voice ID: \`${voiceId}\`\n` +
                `🔊 Теперь ты будешь слышать ближайших игроков в Discord автоматически!`
            );
        }

        // Если написал что-то другое
        await msg.reply(
            '📋 **Proximity Voice Chat**\n' +
            'Чтобы привязать аккаунт, отправь мне свой **голосовой ID** из игры.\n' +
            'Его можно узнать командой `/voice:vc info` в Minecraft.'
        );
    }
});

// ══ Slash-команды ══════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'vc') return;

    const sub = interaction.options.getSubcommand();

    if (sub === 'info') {
        const db = loadDB();
        const entry = Object.entries(db).find(([, v]) => v.discordId === interaction.user.id);
        if (!entry) {
            return interaction.reply({
                content: '❌ Ты не привязан. Узнай свой ID в игре через `/voice:vc info` и напиши его мне в ЛС.',
                ephemeral: true
            });
        }
        const [voiceId, data] = entry;
        const bans = loadBans();
        return interaction.reply({
            content:
                `📋 **Твои данные Proximity Voice Chat**\n` +
                `🎮 Minecraft: **${data.mcName}**\n` +
                `🆔 Voice ID: \`${voiceId}\`\n` +
                `🔗 Статус: ${data.linked ? '✅ Привязан' : '❌ Не привязан'}\n` +
                `🔊 Войс: ${data.voiceOff ? '🔇 Отключён' : '✅ Активен'}\n` +
                `${bans[voiceId] ? '🚫 Забанен администратором' : ''}`,
            ephemeral: true
        });
    }
});

// ══ HTTP-сервер (принимает данные от аддона) ═══════════════════
const app = express();
app.use(express.json());

// POST /positions — основной эндпоинт от аддона
app.post('/positions', async (req, res) => {
    const { secret, players } = req.body;

    if (secret !== process.env.API_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (!players || !Array.isArray(players)) {
        return res.status(400).json({ error: 'Bad data' });
    }

    try {
        const db   = loadDB();
        const bans = loadBans();

        const guild        = await client.guilds.fetch(process.env.GUILD_ID);
        const voiceChannel = await guild.channels.fetch(process.env.VOICE_CHANNEL_ID);
        if (!voiceChannel) return res.status(404).json({ error: 'Voice channel not found' });

        // Фильтруем: только привязанные, не забаненные, не отключившиеся сами
        const activePlayers = players.filter(p => {
            const entry = db[p.voiceId];
            if (!entry) return false;
            if (!entry.linked) return false;
            if (entry.voiceOff) return false;
            if (bans[p.voiceId]) return false;
            return true;
        });

        // ── Список игроков которым надо напомнить зайти в войс ──
        // (привязан, не забанен, не voiceOff, но НЕ в голосовом канале)
        const notInVoiceNames = []; // для ответа аддону — он напишет в чат

        // ── Для забаненных — принудительный вечный мут ──────────
        for (const p of players) {
            if (!bans[p.voiceId]) continue;
            const entry = db[p.voiceId];
            if (!entry?.discordId) continue;
            const member = voiceChannel.members.get(entry.discordId);
            if (member && !muteState.get(entry.discordId)) {
                await member.voice.setMute(true, 'Voice Chat Ban').catch(() => {});
                muteState.set(entry.discordId, true);
            }
        }

        // ── Проверяем: привязанные игроки в войс-канале? ─────────
        for (const p of activePlayers) {
            const entry = db[p.voiceId];
            if (!entry?.discordId) continue;

            const inVoice = voiceChannel.members.has(entry.discordId);

            if (!inVoice) {
                // Добавляем в список для уведомления в игровом чате
                notInVoiceNames.push(p.name);

                // Отправляем ЛС в Discord — но не чаще раза в 3 минуты
                const lastTime = lastNotified.get(entry.discordId) ?? 0;
                const now = Date.now();

                if (now - lastTime > NOTIFY_COOLDOWN_MS) {
                    lastNotified.set(entry.discordId, now);
                    try {
                        const discordUser = await client.users.fetch(entry.discordId);
                        await discordUser.send(
                            `🎮 **Proximity Voice Chat**\n` +
                            `Ты сейчас играешь на сервере как **${entry.mcName}**, ` +
                            `но не находишься в голосовом канале Discord!\n\n` +
                            `🔊 Зайди в голосовой канал чтобы слышать ближайших игроков.\n` +
                            `_(это сообщение повторится не чаще чем раз в 3 минуты)_`
                        );
                        console.log(`[Notify] ЛС → ${entry.mcName} (${entry.discordId}): не в войс-канале`);
                    } catch (dmErr) {
                        // Игрок закрыл ЛС — ничего страшного
                        console.warn(`[Notify] Не удалось отправить ЛС ${entry.discordId}:`, dmErr.message);
                    }
                }
            }
        }

        // ── Считаем дистанции для тех кто В войс-канале ──────────
        const HEAR_DISTANCE = Number(process.env.HEAR_DISTANCE) || 80;

        // Фильтруем activePlayers — только те кто реально в войс-канале
        const inVoicePlayers = activePlayers.filter(p => {
            const entry = db[p.voiceId];
            return entry?.discordId && voiceChannel.members.has(entry.discordId);
        });

        const muteDecisions = calcMutes(inVoicePlayers, HEAR_DISTANCE);

        for (const [voiceId, shouldBeMuted] of muteDecisions) {
            const entry = db[voiceId];
            if (!entry?.discordId) continue;

            const member = voiceChannel.members.get(entry.discordId);
            if (!member) continue;

            const currentMute = muteState.get(entry.discordId) ?? false;
            if (shouldBeMuted !== currentMute) {
                await member.voice.setMute(shouldBeMuted, 'Proximity Voice Chat').catch(() => {});
                muteState.set(entry.discordId, shouldBeMuted);
                console.log(`[Voice] ${entry.mcName} ${shouldBeMuted ? '🔇 MUTED' : '🔊 UNMUTED'}`);
            }
        }

        // ── Для тех кто voiceOff — мутим если ещё не ─────────────
        for (const p of players) {
            const entry = db[p.voiceId];
            if (!entry?.discordId || !entry.voiceOff) continue;
            const member = voiceChannel.members.get(entry.discordId);
            if (member && muteState.get(entry.discordId) !== true) {
                await member.voice.setMute(true, 'Player self-muted').catch(() => {});
                muteState.set(entry.discordId, true);
            }
        }

        // Возвращаем аддону список игроков не в войс-канале
        // Аддон напишет им в игровой чат
        res.json({
            ok: true,
            processed: inVoicePlayers.length,
            notInVoice: notInVoiceNames,
        });

    } catch (err) {
        console.error('[/positions]', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /admin — действия от аддона для бана/анбана/voiceOff/voiceOn
app.post('/admin', async (req, res) => {
    const { secret, action, voiceId, mcName } = req.body;

    if (secret !== process.env.API_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const db   = loadDB();
    const bans = loadBans();

    try {
        const guild        = await client.guilds.fetch(process.env.GUILD_ID);
        const voiceChannel = await guild.channels.fetch(process.env.VOICE_CHANNEL_ID);

        switch (action) {

            // ── Регистрация нового игрока (при входе в мир) ──
            case 'register': {
                // Если уже есть запись с этим ником — находим и обновляем voiceId
                const existing = Object.entries(db).find(([, v]) => v.mcName === mcName);
                if (existing) {
                    // Перемещаем данные на новый ID (если был re)
                    const [oldId, oldData] = existing;
                    if (oldId !== voiceId) {
                        db[voiceId] = { ...oldData, voiceId };
                        delete db[oldId];
                    }
                } else {
                    if (!db[voiceId]) {
                        db[voiceId] = { mcName, discordId: null, linked: false, voiceOff: false };
                    }
                }
                saveDB(db);
                return res.json({ ok: true });
            }

            // ── Сброс ID игрока (/voice:vc re) ───────────────
            case 'resetId': {
                // Сброс привязки Discord для старого ID
                // (аддон уже сгенерировал новый ID и вызывает register после)
                const entry = Object.entries(db).find(([, v]) => v.mcName === mcName);
                if (entry) {
                    const [oldId] = entry;
                    delete db[oldId];
                    // Если был забанен — переносим бан (ban по имени сохраняется на уровне аддона)
                    saveDB(db);
                }
                return res.json({ ok: true });
            }

            // ── Ban игрока (/voice:vc ban <voiceId>) ──────────
            case 'ban': {
                bans[voiceId] = true;
                saveBans(bans);
                // Сразу мутим в голосовом
                if (db[voiceId]?.discordId && voiceChannel) {
                    const member = voiceChannel.members.get(db[voiceId].discordId);
                    if (member) {
                        await member.voice.setMute(true, 'Voice Chat Ban').catch(() => {});
                        muteState.set(db[voiceId].discordId, true);
                    }
                }
                return res.json({ ok: true, action: 'banned', voiceId });
            }

            // ── Unban игрока (/voice:vc unban <voiceId>) ──────
            case 'unban': {
                delete bans[voiceId];
                saveBans(bans);
                return res.json({ ok: true, action: 'unbanned', voiceId });
            }

            // ── Игрок сам отключается (/voice:vc off) ─────────
            case 'voiceOff': {
                if (db[voiceId]) {
                    db[voiceId].voiceOff = true;
                    saveDB(db);
                    // Мутим сразу
                    if (db[voiceId].discordId && voiceChannel) {
                        const member = voiceChannel.members.get(db[voiceId].discordId);
                        if (member) {
                            await member.voice.setMute(true, 'Self muted').catch(() => {});
                            muteState.set(db[voiceId].discordId, true);
                        }
                    }
                }
                return res.json({ ok: true });
            }

            // ── Игрок сам включается (/voice:vc on) ───────────
            case 'voiceOn': {
                if (db[voiceId]) {
                    if (bans[voiceId]) {
                        return res.json({ ok: false, reason: 'banned' });
                    }
                    db[voiceId].voiceOff = false;
                    saveDB(db);
                }
                return res.json({ ok: true });
            }

            default:
                return res.status(400).json({ error: 'Unknown action' });
        }

    } catch (err) {
        console.error('[/admin]', err);
        res.status(500).json({ error: err.message });
    }
});

// ══ Запуск ════════════════════════════════════════════════════

client.once('ready', async () => {
    console.log(`✅ Discord бот запущен: ${client.user.tag}`);

    // Регистрация slash-команд
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await rest.put(
        Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
        { body: commands }
    ).catch(console.error);
    console.log('✅ Slash-команды зарегистрированы');
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 HTTP сервер запущен на порту ${PORT}`);
});
