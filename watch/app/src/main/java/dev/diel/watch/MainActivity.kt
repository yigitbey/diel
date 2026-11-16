package dev.diel.watch

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.speech.RecognizerIntent
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import kotlinx.coroutines.delay

private const val SEND_DELAY_MS = 2000L

class MainActivity : ComponentActivity() {
    private lateinit var client: BridgeClient

    // Keep the screen on only while the watch sits on its charger.
    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
            if (plugged) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        client = BridgeClient(applicationContext)
        // Debug builds can be forced into a state for screenshots:
        //   adb shell am start -n dev.diel.watch/.MainActivity --es demo working [--es voice speaking]
        val demo = if (BuildConfig.DEBUG) intent?.getStringExtra("demo") else null
        val demoVoice = if (BuildConfig.DEBUG) intent?.getStringExtra("voice") else null
        setContent { MaterialTheme { DielScreen(client, ::buzz, demo, demoVoice) } }
    }

    override fun onStart() {
        super.onStart()
        // ACTION_BATTERY_CHANGED is sticky, so this fires immediately with the current state.
        registerReceiver(powerReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        client.start()
    }

    override fun onStop() {
        unregisterReceiver(powerReceiver)
        client.stop()
        super.onStop()
    }

    private fun buzz(long: Boolean) {
        val pattern = if (long) longArrayOf(0, 120, 90, 120) else longArrayOf(0, 60)
        getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createWaveform(pattern, -1))
    }
}

@Composable
fun DielScreen(client: BridgeClient, buzz: (Boolean) -> Unit, demo: String? = null, demoVoice: String? = null) {
    val liveState by client.state.collectAsStateWithLifecycle()
    val liveVoice by client.voice.collectAsStateWithLifecycle()
    val state = demo?.let { d -> liveState.copy(status = Status.entries.firstOrNull { it.name.equals(d.replace("-", "_"), true) } ?: liveState.status) } ?: liveState
    val voice = demoVoice?.let { v -> VoiceState.entries.firstOrNull { it.name.equals(v, true) } } ?: liveVoice
    val context = LocalContext.current
    var pending by remember { mutableStateOf<String?>(null) }
    var flash by remember { mutableStateOf<String?>(null) }

    // Tell the wearer when the agent starts needing them, and when it finishes.
    var previous by remember { mutableStateOf(state.status) }
    LaunchedEffect(state.status) {
        if (state.status == Status.NEEDS_YOU && previous != Status.NEEDS_YOU) buzz(true)
        if (state.status == Status.IDLE && previous == Status.WORKING) buzz(false)
        if (state.status == Status.ERROR && previous == Status.WORKING) buzz(true)
        previous = state.status
    }

    LaunchedEffect(Unit) {
        client.events.collect {
            flash = it
            delay(2500)
            flash = null
        }
    }

    // Spoken text waits briefly so a bad transcription can be cancelled.
    LaunchedEffect(pending) {
        val text = pending ?: return@LaunchedEffect
        delay(SEND_DELAY_MS)
        client.say(text)
        pending = null
    }

    val speech = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val heard = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            if (!heard.isNullOrBlank()) pending = heard
        }
    }
    val listen = {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Tell your agent")
        runCatching { speech.launch(intent) }.onFailure { flash = "No speech recogniser on this watch" }
        Unit
    }

    // Live voice needs the microphone permission; ask the first time.
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) client.startVoice() else flash = "Microphone permission needed"
    }
    val talk = {
        when {
            voice != VoiceState.OFF -> client.stopVoice()
            // No API key on the Mac: fall back to dictate-and-send.
            !state.voiceAvailable -> listen()
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED -> client.startVoice()
            else -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    // Rest dimmer when nothing is happening, to go easy on the always-on OLED.
    var touched by remember { mutableStateOf(0) }
    var dimmed by remember { mutableStateOf(false) }
    LaunchedEffect(touched, state.status, pending, voice) {
        dimmed = false
        if (voice == VoiceState.OFF && (state.status == Status.IDLE || state.status == Status.OFFLINE)) {
            delay(30_000)
            dimmed = pending == null
        }
    }

    val heard = pending
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .alpha(if (dimmed) 0.4f else 1f),
        contentAlignment = Alignment.Center,
    ) {
        if (heard != null) {
            Confirming(heard, onCancel = { pending = null })
        } else {
            AgentButton(
                status = state.status,
                voice = voice,
                modifier = Modifier
                    .fillMaxSize(0.97f)
                    .clip(CircleShape)
                    .clickable(enabled = state.status != Status.OFFLINE || voice != VoiceState.OFF) {
                        touched++
                        talk()
                    },
            )
            // Text only when something is wrong: an error, or why it's offline.
            val note = flash ?: state.notice.takeIf { state.status == Status.OFFLINE }
            if (!note.isNullOrEmpty()) {
                Text(
                    text = note,
                    fontSize = 11.sp,
                    lineHeight = 13.sp,
                    color = if (flash != null) statusColor(Status.ERROR) else Color(0xFF8A8F98),
                    textAlign = TextAlign.Center,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(start = 56.dp, end = 56.dp, bottom = 10.dp),
                )
            }
        }
    }
}

@Composable
private fun Confirming(text: String, onCancel: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .clickable(onClick = onCancel)
            .padding(horizontal = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Sending…", fontSize = 12.sp, color = statusColor(Status.WORKING))
        Spacer(Modifier.height(6.dp))
        Text(text, fontSize = 15.sp, textAlign = TextAlign.Center, maxLines = 6, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(8.dp))
        Text("Tap to cancel", fontSize = 12.sp, color = Color(0xFF8A8F98))
    }
}
