package dev.diel.watch

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import kotlin.math.hypot

/*
 * Diel's pet: an original round pixel creature drawn on a 32x32 grid, animated
 * in steps (8 frames a second) like a sprite. Its body is a pixel circle so it
 * sits naturally inside the round button.
 */

private const val GRID = 32
private const val CX = 16f
private const val CY = 17f
private const val R_OUT = 10.4f
private const val R_IN = 9.3f

private val Outline = Color(0xFF4A3C86)
private val Body = Color(0xFFB4A6FF)
private val BodyLight = Color(0xFFD9D1FF)
private val BodyShade = Color(0xFF9483F0)
private val Eye = Color(0xFF1B1530)
private val Glint = Color(0xFFFFFFFF)
private val Cheek = Color(0xFFFF9EC4)
private val Feet = Color(0xFF4A3C86)

/** Precomputed body cells: 0 = outside, 1 = outline, 2 = fill, 3 = highlight, 4 = shade. */
private val bodyCells: Array<IntArray> = Array(GRID) { y ->
    IntArray(GRID) { x ->
        val d = hypot(x + 0.5f - CX, y + 0.5f - CY)
        when {
            d > R_OUT -> 0
            d > R_IN -> 1
            (x - CX) + (y - CY) < -8.5f -> 3
            (x - CX) + (y - CY) > 9f -> 4
            else -> 2
        }
    }
}

private class Pixels(val scope: DrawScope, val origin: Offset, val cell: Float) {
    fun px(x: Int, y: Int, c: Color) {
        if (x !in 0 until GRID || y !in 0 until GRID) return
        // Slight overlap avoids hairline gaps between cells.
        scope.drawRect(c, Offset(origin.x + x * cell, origin.y + y * cell), Size(cell + 0.6f, cell + 0.6f))
    }

    fun rect(x: Int, y: Int, w: Int, h: Int, c: Color) {
        for (j in 0 until h) for (i in 0 until w) px(x + i, y + j, c)
    }
}

/**
 * Draws the pet centred at [c], fitting inside a circle of radius [r].
 * [frame] advances 8 times a second.
 */
fun DrawScope.pixelPet(c: Offset, r: Float, status: Status, voice: VoiceState, frame: Int, accent: Color) {
    val size = r * 1.95f
    val p = Pixels(this, Offset(c.x - size / 2, c.y - size / 2), size / GRID)
    val listening = voice == VoiceState.LISTENING
    val speaking = voice == VoiceState.SPEAKING
    val live = listening || speaking || voice == VoiceState.CONNECTING
    val mood = if (live) null else status

    // Body motion.
    val dy = when {
        mood == Status.NEEDS_YOU -> intArrayOf(0, -1, -3, -4, -3, -1, 0, 0)[frame % 8]
        mood == Status.WORKING -> if ((frame / 2) % 2 == 0) 0 else -1
        speaking -> if ((frame / 3) % 2 == 0) 0 else -1
        mood == Status.OFFLINE -> 0
        else -> if ((frame / 6) % 2 == 0) 0 else -1
    }
    // Offline breathes by squashing one row.
    val squash = mood == Status.OFFLINE && (frame / 8) % 2 == 1

    // Feet stay on the ground while the body hops.
    val footLift = if (mood == Status.NEEDS_YOU && dy <= -3) -1 else 0
    val step = mood == Status.WORKING && (frame / 2) % 2 == 1
    p.rect(11, 27 + footLift - (if (step) 1 else 0), 3, 2, Feet)
    p.rect(18, 27 + footLift - (if (!step && mood == Status.WORKING) 1 else 0), 3, 2, Feet)

    // Body.
    for (y in 0 until GRID) for (x in 0 until GRID) {
        val kind = bodyCells[y][x]
        if (kind == 0) continue
        if (squash && y < 9) continue
        val color = when (kind) {
            1 -> Outline
            3 -> BodyLight
            4 -> BodyShade
            else -> Body
        }
        p.px(x, y + dy + (if (squash && y >= 9) 0 else 0), color)
    }
    if (squash) for (x in 0 until GRID) if (bodyCells[8][x] != 0) p.px(x, 9 + dy, Outline)

    // Antenna with a light in the agent's colour.
    val top = (if (squash) 9 else 7) + dy
    p.px(16, top - 1, Outline)
    p.px(16, top - 2, Outline)
    val bulbOn = when (mood) {
        Status.WORKING, Status.NEEDS_YOU -> (frame / 2) % 2 == 0
        Status.OFFLINE -> false
        else -> true
    }
    p.rect(15, top - 4, 2, 2, if (bulbOn) accent else Outline)

    // Eyes.
    val ex = when {
        mood == Status.WORKING -> intArrayOf(-1, -1, 0, 1, 1, 0)[(frame / 3) % 6]
        else -> 0
    }
    val ey = 14 + dy + (if (listening) -1 else 0)
    val blinking = (mood == Status.IDLE || mood == null && !listening) && frame % 40 in 0..1
    for (base in intArrayOf(11, 19)) {
        val x = base + ex
        when {
            mood == Status.OFFLINE -> p.rect(x, ey + 2, 3, 1, Eye)
            mood == Status.ERROR -> {
                p.px(x, ey, Eye); p.px(x + 2, ey, Eye); p.px(x + 1, ey + 1, Eye); p.px(x, ey + 2, Eye); p.px(x + 2, ey + 2, Eye)
            }
            blinking -> p.rect(x, ey + 2, 3, 1, Eye)
            mood == Status.NEEDS_YOU || listening -> {
                p.rect(x, ey, 3, 3, Eye)
                p.px(x, ey, Glint)
            }
            else -> {
                p.rect(x + 1, ey, 2, 3, Eye)
                p.px(x + 1, ey, Glint)
            }
        }
    }

    // Cheeks.
    if (mood == Status.IDLE || mood == Status.NEEDS_YOU || live) {
        p.rect(9, 18 + dy, 2, 1, Cheek)
        p.rect(22, 18 + dy, 2, 1, Cheek)
    }

    // Mouth.
    val my = 19 + dy
    when {
        speaking -> when ((frame + frame / 3) % 3) {
            0 -> p.rect(15, my, 3, 2, Eye)
            1 -> p.rect(15, my, 3, 1, Eye)
            else -> { p.rect(15, my, 3, 3, Eye); p.px(16, my + 2, Cheek) }
        }
        listening -> p.rect(16, my, 1, 1, Eye)
        mood == Status.NEEDS_YOU -> { p.rect(15, my, 2, 2, Eye) }
        mood == Status.ERROR -> { p.px(14, my + 1, Eye); p.px(15, my, Eye); p.px(16, my + 1, Eye); p.px(17, my, Eye) }
        mood == Status.OFFLINE -> p.rect(15, my + 1, 2, 1, Eye)
        mood == Status.WORKING -> p.rect(15, my, 2, 1, Eye)
        else -> { p.px(14, my, Eye); p.rect(15, my + 1, 2, 1, Eye); p.px(17, my, Eye) }
    }

    // Effects around the pet.
    when {
        mood == Status.OFFLINE -> {
            // Pixel "z"s drifting up and to the right.
            val t = frame % 16
            val zx = 24 + t / 6
            val zy = 9 - t / 3
            val z = Outline.copy(alpha = 0.4f + 0.6f * (1f - t / 16f))
            p.rect(zx, zy, 3, 1, z); p.px(zx + 1, zy + 1, z); p.rect(zx, zy + 2, 3, 1, z)
        }
        mood == Status.NEEDS_YOU -> {
            // Exclamation mark.
            p.rect(26, 4 + dy, 2, 4, accent)
            p.rect(26, 9 + dy, 2, 1, accent)
        }
        mood == Status.WORKING -> {
            // Three dots filling in turn.
            val lit = (frame / 3) % 4
            for (i in 0 until 3) p.px(23 + i * 2, 6, if (i < lit) accent else Outline.copy(alpha = 0.35f))
        }
        mood == Status.ERROR -> {
            // Dizzy sparks swapping places.
            val a = (frame / 3) % 2 == 0
            p.px(if (a) 6 else 25, 7, accent); p.px(if (a) 25 else 6, 9, accent)
        }
        listening -> {
            // Sound waves arriving from both sides.
            val reach = (frame / 2) % 3
            for (k in 0..reach) {
                val o = 4 - k * 2
                p.rect(o, 15, 1, 3, accent.copy(alpha = 1f - k * 0.25f))
                p.rect(GRID - 1 - o, 15, 1, 3, accent.copy(alpha = 1f - k * 0.25f))
            }
        }
    }
}
