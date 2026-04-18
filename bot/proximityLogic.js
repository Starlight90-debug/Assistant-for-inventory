/**
 * proximityLogic.js
 * Логика расчёта дистанций между игроками для proximity voice
 */

/**
 * 3D-дистанция между двумя игроками
 */
function distance3D(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Считает решения о муте для каждого игрока.
 *
 * Логика:
 * - Если рядом (≤ hearDistance) хотя бы один другой игрок → НЕ мутить
 * - Если никого нет рядом → мутить
 *
 * @param {Array<{voiceId, name, x, y, z}>} players
 * @param {number} hearDistance — радиус в блоках
 * @returns {Map<voiceId, boolean>} — true = надо замутить
 */
function calcMutes(players, hearDistance) {
    const dist   = Number(hearDistance);
    const result = new Map();

    if (players.length === 0) return result;

    // Если игрок один — мутим (говорить не с кем)
    if (players.length === 1) {
        result.set(players[0].voiceId, true);
        return result;
    }

    for (const player of players) {
        let hasNearby = false;

        for (const other of players) {
            if (other.voiceId === player.voiceId) continue;
            if (distance3D(player, other) <= dist) {
                hasNearby = true;
                break;
            }
        }

        result.set(player.voiceId, !hasNearby);
    }

    return result;
}

module.exports = { calcMutes, distance3D };
