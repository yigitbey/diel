package dev.diel.watch

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke

fun statusColor(status: Status): Color = when (status) {
    Status.OFFLINE -> Color(0xFF50545C)
    Status.IDLE -> Color(0xFF4C8DFF)
    Status.WORKING -> Color(0xFF37C98B)
    Status.NEEDS_YOU -> Color(0xFFFFB020)
    Status.ERROR -> Color(0xFFFF5A4F)
}

private val ButtonIdle = Color(0xFF1C1F25)
private val ButtonConnecting = Color(0xFF3A3F48)
private val ButtonLive = Color(0xFFEDEBFA)

/**
 * The whole UI: one round button with a ring around it.
 *
 * Ring = the agent: dim grey offline, blue ready, a spinning green arc while it
 * works, pulsing amber when it needs you, red after an error.
 * Button = the conversation: dark when off, grey while connecting, white while live.
 * Inside it is the pet (see PixelPet.kt), which acts out both.
 */
@Composable
fun AgentButton(status: Status, voice: VoiceState, modifier: Modifier = Modifier) {
    val ringColor by animateColorAsState(statusColor(status), tween(400), label = "ring")
    val fill by animateColorAsState(
        when (voice) {
            VoiceState.OFF -> ButtonIdle
            VoiceState.CONNECTING -> ButtonConnecting
            else -> ButtonLive
        },
        tween(250),
        label = "fill",
    )
    val loop = rememberInfiniteTransition(label = "agent")
    val spin by loop.animateFloat(0f, 360f, infiniteRepeatable(tween(1300, easing = LinearEasing)), label = "spin")
    val pulse by loop.animateFloat(1f, 0.35f, infiniteRepeatable(tween(550), RepeatMode.Reverse), label = "pulse")
    val breathe by loop.animateFloat(1f, 0.94f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "breathe")
    // Sprite frames: 8 a second.
    var frame by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(125)
            frame++
        }
    }

    Canvas(modifier) {
        val r = size.minDimension / 2
        val c = center
        val ringWidth = r * 0.05f
        val ringRadius = r - ringWidth / 2
        val ringTopLeft = Offset(c.x - ringRadius, c.y - ringRadius)
        val ringSize = Size(ringRadius * 2, ringRadius * 2)

        // Agent ring.
        when (status) {
            Status.WORKING -> {
                drawCircle(ringColor.copy(alpha = 0.22f), ringRadius, c, style = Stroke(ringWidth))
                drawArc(ringColor, spin, 110f, false, ringTopLeft, ringSize, style = Stroke(ringWidth, cap = StrokeCap.Round))
            }
            Status.NEEDS_YOU -> drawCircle(ringColor.copy(alpha = pulse), ringRadius, c, style = Stroke(ringWidth))
            Status.OFFLINE -> drawCircle(ringColor.copy(alpha = 0.5f), ringRadius, c, style = Stroke(ringWidth * 0.6f))
            else -> drawCircle(ringColor, ringRadius, c, style = Stroke(ringWidth))
        }

        // Conversation button.
        val buttonRadius = r * 0.86f * (if (voice == VoiceState.CONNECTING) breathe else 1f)
        drawCircle(fill, buttonRadius, c)
        pixelPet(c, buttonRadius, status, voice, frame, ringColor)
    }
}
