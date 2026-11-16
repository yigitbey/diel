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
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.focus.FocusRequester
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun DielScreen(client: BridgeClient, buzz: (Boolean) -> Unit, demo: String? = null, demoVoice: String? = null) {
    val liveState by client.state.collectAsStateWithLifecycle()
    val liveVoice by client.voice.collectAsStateWithLifecycle()
    val state = demo?.let { d -> liveState.copy(status = Status.entries.firstOrNull { it.name.equals(d.replace("-", "_"), true) } ?: liveState.status) } ?: liveState
    val voice = demoVoice?.let { v -> VoiceState.entries.firstOrNull { it.name.equals(v, true) } } ?: liveVoice
    val context = LocalContext.current
    var pending by remember { mutableStateOf<String?>(null) }
    var flash by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    var showPicker by remember { mutableStateOf(false) }
    var pairingBusy by remember { mutableStateOf(false) }
    val macs by client.macs.entries.collectAsStateWithLifecycle()
    val auto by client.macs.auto.collectAsStateWithLifecycle()
    val pairPrompt by client.macs.pairPrompt.collectAsStateWithLifecycle()

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

    LaunchedEffect(Unit) {
        client.info.collect {
            note = it
            delay(2500)
            note = null
        }
    }
    val pair = { id: String ->
        pairingBusy = true
        client.macs.pair(id) { error ->
            pairingBusy = false
            if (error != null) flash = error else { showPicker = false; buzz(false) }
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
        val prompt = pairPrompt
        if (heard != null) {
            Confirming(heard, onCancel = { pending = null })
        } else if (prompt != null && !showPicker) {
            PairPrompt(prompt.name, pairingBusy, onPair = { pair(prompt.id) }, onDecline = { client.macs.declinePairing(prompt.id) })
        } else if (showPicker) {
            BackHandler { showPicker = false }
            MacPicker(
                macs = macs,
                auto = auto,
                onAuto = { client.macs.chooseAuto(); showPicker = false },
                onPick = { id -> client.macs.choose(id); showPicker = false },
                onPair = { id -> pair(id) },
                onForget = { id -> client.macs.forget(id); buzz(false) },
            )
        } else {
            AgentButton(
                status = state.status,
                voice = voice,
                modifier = Modifier
                    .fillMaxSize(0.97f)
                    .clip(CircleShape)
                    .combinedClickable(
                        onLongClick = { touched++; showPicker = true },
                        onClick = {
                            touched++
                            if (state.status != Status.OFFLINE || voice != VoiceState.OFF) talk() else showPicker = true
                        },
                    ),
            )
            // Text only when something is wrong: an error, or why it's offline.
            val line = flash ?: note ?: state.notice.takeIf { state.status == Status.OFFLINE }
            if (!line.isNullOrEmpty()) {
                Text(
                    text = line,
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
private fun PairPrompt(name: String, busy: Boolean, onPair: () -> Unit, onDecline: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 34.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Pair with", fontSize = 13.sp, color = Color(0xFF8A8F98))
        Text(name, fontSize = 16.sp, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(14.dp))
        Pill(if (busy) "Pairing…" else "Pair", statusColor(Status.IDLE), enabled = !busy, onClick = onPair)
        Spacer(Modifier.height(8.dp))
        Pill("Not now", Color(0xFF2C3038), enabled = !busy, onClick = onDecline)
    }
}

/** Long-press the pet: follow the Mac you use, or stay on one. */
@Composable
private fun MacPicker(
    macs: List<MacEntry>, auto: Boolean, onAuto: () -> Unit, onPick: (String) -> Unit, onPair: (String) -> Unit, onForget: (String) -> Unit,
) {
    val scroll = rememberScrollState()
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Column(
        Modifier
            .fillMaxSize()
            .rotaryScrollable(RotaryScrollableDefaults.behavior(scroll), focus)
            .verticalScroll(scroll)
            .padding(horizontal = 22.dp, vertical = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Talk to", fontSize = 13.sp, color = Color(0xFF8A8F98))
        PickerRow("Auto", "Last used Mac", selected = auto, onClick = onAuto)
        for (m in macs.filter { it.paired }) {
            PickerRow(
                m.name,
                when {
                    m.current -> "Connected"
                    m.reachable -> "Nearby"
                    else -> "Not found"
                },
                selected = !auto && m.current,
                onClick = { onPick(m.id) },
                onLongClick = { onForget(m.id) },
            )
        }
        for (m in macs.filter { !it.paired && it.pairing }) PickerRow(m.name, "Tap to pair", selected = false, onClick = { onPair(m.id) })
        if (macs.any { it.paired }) {
            Text("Long-press a Mac to forget it", fontSize = 11.sp, color = Color(0xFF8A8F98), textAlign = TextAlign.Center)
        } else {
            Text("Run npm run pair on a Mac to add it.", fontSize = 11.sp, color = Color(0xFF8A8F98), textAlign = TextAlign.Center)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PickerRow(title: String, subtitle: String, selected: Boolean, onClick: () -> Unit, onLongClick: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(22.dp))
            .background(if (selected) Color(0xFF26324A) else Color(0xFF1C1F25))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, fontSize = 11.sp, color = Color(0xFF8A8F98), maxLines = 1)
        }
        if (selected) Text("✓", fontSize = 14.sp, color = statusColor(Status.IDLE))
    }
}

@Composable
private fun Pill(label: String, color: Color, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(CircleShape)
            .background(color)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 22.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, fontSize = 14.sp, color = Color.White) }
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
