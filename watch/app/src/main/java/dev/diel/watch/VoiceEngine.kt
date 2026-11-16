package dev.diel.watch

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.NoiseSuppressor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

private const val RATE = 24_000
private const val CHUNK_BYTES = RATE / 25 * 2 // 40 ms of PCM16 mono

/**
 * Microphone capture and speech playback for a live voice session.
 * Both directions are raw PCM16, 24 kHz, mono.
 */
class VoiceEngine(private val context: Context, private val onMic: (ByteArray) -> Unit) {
    @Volatile private var running = false
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var ns: NoiseSuppressor? = null
    private val playQueue = LinkedBlockingQueue<ByteArray>()
    private val framesQueued = AtomicLong(0)

    /** Requires RECORD_AUDIO to have been granted. */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (running) return true
        val format = AudioFormat.Builder()
            .setSampleRate(RATE)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)

        val minIn = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val minOut = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minIn <= 0 || minOut <= 0) return false

        // VOICE_RECOGNITION is the source the watch's own dictation uses. The call-style
        // VOICE_COMMUNICATION source is refused on the Pixel Watch (startInput -38) while
        // the Assistant's hotword listener holds the mic.
        val rec = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(format.setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
            .setBufferSizeInBytes(maxOf(minIn, CHUNK_BYTES * 4))
            .build()
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        runCatching { rec.startRecording() }
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            rec.release()
            return false
        }
        val out = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(maxOf(minOut, CHUNK_BYTES * 8))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        // Outside a call the watch does not cancel its own speaker from the mic, so the
        // mic is muted while speech plays (no talking over the voice).
        val echoCancelled = false
        if (NoiseSuppressor.isAvailable()) {
            ns = NoiseSuppressor.create(rec.audioSessionId)?.also { runCatching { it.enabled = true } }
        }

        record = rec
        track = out
        running = true
        playQueue.clear()
        framesQueued.set(0)
        out.play()

        thread(name = "diel-mic") {
            val buf = ByteArray(CHUNK_BYTES)
            while (running) {
                val n = rec.read(buf, 0, buf.size)
                if (n <= 0) continue
                // Without echo cancellation the mic would hear our own speaker and
                // interrupt the reply, so stay quiet while speech is playing.
                if (!echoCancelled && isPlaying()) continue
                onMic(buf.copyOf(n))
            }
        }
        thread(name = "diel-speaker") {
            while (running) {
                val chunk = playQueue.poll(100, TimeUnit.MILLISECONDS) ?: continue
                runCatching { out.write(chunk, 0, chunk.size) }
            }
        }
        return true
    }

    @Volatile private var lastAudibleAt = 0L

    /** True while speech is coming out of the speaker, plus a short tail for it to ring out. */
    private fun isPlaying(): Boolean {
        val t = track ?: return false
        val played = runCatching { t.playbackHeadPosition.toLong() and 0xFFFFFFFFL }.getOrDefault(0L)
        val now = System.currentTimeMillis()
        if (playQueue.isNotEmpty() || framesQueued.get() > played) lastAudibleAt = now
        return now - lastAudibleAt < 250
    }

    /** Queue speech from the bridge. */
    fun play(pcm: ByteArray) {
        if (!running) return
        framesQueued.addAndGet(pcm.size / 2L)
        playQueue.offer(pcm)
    }

    /** The user interrupted: drop everything not yet heard. */
    fun clearPlayback() {
        playQueue.clear()
        track?.let {
            runCatching {
                it.pause()
                it.flush()
                it.play()
            }
        }
        framesQueued.set(0)
    }

    fun stop() {
        if (!running) return
        running = false
        playQueue.clear()
        runCatching { record?.stop() }
        runCatching { track?.pause(); track?.flush() }
        // Give the worker threads a moment to leave their blocking calls.
        Thread.sleep(60)
        runCatching { ns?.release() }
        runCatching { record?.release() }
        runCatching { track?.release() }
        ns = null
        record = null
        track = null
    }
}
