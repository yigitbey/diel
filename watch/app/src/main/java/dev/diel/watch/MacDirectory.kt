package dev.diel.watch

import android.content.Context
import android.net.Network
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.net.Inet4Address
import java.util.concurrent.TimeUnit

/** Where to connect: a paired Mac's bridge at its current address. */
data class Target(val id: String, val name: String, val host: String, val port: Int, val token: String)

/** One Mac as the picker shows it. */
data class MacEntry(
    val id: String,
    val name: String,
    val paired: Boolean,
    val reachable: Boolean,
    val pairing: Boolean,
    val current: Boolean,
)

private const val SERVICE = "_diel._tcp"
private const val POLL_MS = 8_000L
private const val FRESH_MS = 30_000L
// Auto mode moves to another Mac only when you've clearly switched: the current
// one has been untouched for a while and the other was used more recently.
private const val LEAVE_AFTER_IDLE_S = 45L
private const val SWITCH_MARGIN_S = 30L

/**
 * Finds Diel bridges on the Wi-Fi network (Bonjour), remembers the ones this
 * watch paired with, and picks which one to talk to: a fixed Mac, or in auto
 * mode the paired Mac you used most recently. All state lives on the main thread.
 */
class MacDirectory(
    context: Context,
    private val onTarget: (Target?) -> Unit,
    /** True while switching would interrupt something (a live conversation). */
    private val isBusy: () -> Boolean,
    private val onSwitched: (String) -> Unit,
) {
    val entries = MutableStateFlow<List<MacEntry>>(emptyList())
    val auto = MutableStateFlow(true)
    /** A nearby unpaired Mac with its pairing window open. */
    val pairPrompt = MutableStateFlow<MacEntry?>(null)

    private class Found(
        val id: String, val name: String, val host: String, val port: Int, val pairing: Boolean,
        val serviceName: String, val info: NsdServiceInfo,
    )
    private class Known(val id: String, val name: String, val token: String)
    private class Presence(val idle: Long, val at: Long)

    private val main = Handler(Looper.getMainLooper())
    private val appContext = context.applicationContext
    private val prefs = context.getSharedPreferences("macs", Context.MODE_PRIVATE)
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val found = LinkedHashMap<String, Found>()
    private val presence = HashMap<String, Presence>()
    private val known = LinkedHashMap<String, Known>()
    private val legacyTried = HashSet<String>()
    private val declined = HashSet<String>()
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var http: OkHttpClient? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private var current: Target? = null
    private var running = false

    init {
        loadKnown()
        auto.value = prefs.getString("mode", "auto") == "auto"
    }

    fun start(network: Network) {
        stop()
        running = true
        http = OkHttpClient.Builder()
            .socketFactory(network.socketFactory)
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(4, TimeUnit.SECONDS)
            .build()
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) = main.post { enqueueResolve(info) }.let {}
            override fun onServiceLost(info: NsdServiceInfo) = main.post {
                found.values.firstOrNull { it.serviceName == info.serviceName }?.let { found.remove(it.id) }
                reevaluate()
            }.let {}
        }
        discovery = listener
        if (Build.VERSION.SDK_INT >= 33) {
            runCatching { nsd.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, network, appContext.mainExecutor, listener) }
                .onFailure { runCatching { nsd.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, listener) } }
        } else {
            runCatching { nsd.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, listener) }
        }
        main.post(poller)
    }

    fun stop() {
        running = false
        main.removeCallbacks(poller)
        discovery?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        discovery = null
        resolveQueue.clear()
        resolving = false
        found.clear()
        presence.clear()
        http?.dispatcher?.executorService?.shutdown()
        http = null
        if (current != null) {
            current = null
            onTarget(null)
        }
        publish()
    }

    /** Follow the most recently used Mac. */
    fun chooseAuto() {
        prefs.edit().putString("mode", "auto").apply()
        auto.value = true
        reevaluate(force = true)
    }

    /** Stay on one Mac. */
    fun choose(id: String) {
        if (id !in known) return
        prefs.edit().putString("mode", id).apply()
        auto.value = false
        reevaluate(force = true)
    }

    fun forget(id: String) {
        known.remove(id)
        saveKnown()
        if (prefs.getString("mode", "auto") == id) chooseAuto() else reevaluate(force = true)
    }

    fun declinePairing(id: String) {
        declined += id
        publish()
    }

    /** Pair with a Mac whose pairing window is open. */
    fun pair(id: String, done: (String?) -> Unit) {
        val f = found[id]
        val client = http
        if (f == null || client == null) return done("That Mac isn't nearby any more")
        client.newWebSocket(Request.Builder().url("ws://${f.host}:${f.port}/watch").build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("type", "pair").put("device", Build.MODEL).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val m = runCatching { JSONObject(text) }.getOrNull() ?: return
                if (m.optString("type") != "paired") return
                main.post {
                    known[m.getString("id")] = Known(m.getString("id"), m.optString("name", f.name), m.getString("token"))
                    saveKnown()
                    // You paired it from that Mac, so that's the one you're using now.
                    if (!auto.value) choose(m.getString("id")) else reevaluate(force = true, prefer = m.getString("id"))
                    done(null)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (code != 1000) main.post { done(if (code == 4403) "Pairing window closed. Run npm run pair again." else "Pairing failed") }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { done("Couldn't reach that Mac") }
            }
        })
    }

    // ---- discovery ---------------------------------------------------------

    private fun enqueueResolve(info: NsdServiceInfo) {
        if (!running) return
        resolveQueue.addLast(info)
        resolveNext()
    }

    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (resolving || resolveQueue.isEmpty()) return
        resolving = true
        val info = resolveQueue.removeFirst()
        nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = main.post {
                resolving = false
                resolveNext()
            }.let {}

            override fun onServiceResolved(s: NsdServiceInfo) = main.post {
                resolving = false
                addFound(s)
                resolveNext()
            }.let {}
        })
    }

    private fun addFound(s: NsdServiceInfo) {
        val attrs = s.attributes
        val id = attrs["id"]?.let { String(it) } ?: return
        val pairing = attrs["pair"]?.let { String(it) } == "1"
        val addresses = if (Build.VERSION.SDK_INT >= 34) s.hostAddresses else listOfNotNull(s.host)
        val host = (addresses.firstOrNull { it is Inet4Address } ?: addresses.firstOrNull())?.hostAddress ?: return
        found[id] = Found(id, s.serviceName, host, s.port, pairing, s.serviceName, s)
        if (!pairing) declined -= id
        poll(found[id]!!)
        reevaluate()
    }

    // ---- presence ----------------------------------------------------------

    private val poller = object : Runnable {
        override fun run() {
            if (!running) return
            found.values.toList().forEach { poll(it) }
            // Android reports a service once, not when its TXT record changes, so
            // re-resolve unpaired Macs to notice a pairing window opening.
            found.values.filter { it.id !in known }.forEach { enqueueResolve(it.info) }
            main.postDelayed(this, POLL_MS)
        }
    }

    private fun poll(f: Found) {
        val token = known[f.id]?.token
            // A watch built with a Mac's token before pairing existed: see if it fits.
            ?: BuildConfig.BRIDGE_TOKEN.takeIf { it.isNotEmpty() && f.id !in legacyTried }
            ?: return
        val client = http ?: return
        val req = Request.Builder().url("http://${f.host}:${f.port}/presence").header("Authorization", "Bearer $token").build()
        client.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}

            override fun onResponse(call: Call, response: Response) {
                val body = response.use { if (it.isSuccessful) it.body?.string() else null }
                main.post {
                    if (f.id !in known) {
                        legacyTried += f.id
                        if (body == null) return@post
                        known[f.id] = Known(f.id, f.name, token)
                        saveKnown()
                    }
                    val m = body?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return@post
                    presence[f.id] = Presence(m.optLong("idleSeconds", Long.MAX_VALUE), System.currentTimeMillis())
                    reevaluate()
                }
            }
        })
    }

    // ---- choosing ----------------------------------------------------------

    private fun reevaluate(force: Boolean = false, prefer: String? = null) {
        val now = System.currentTimeMillis()
        val reachable = found.values.filter { it.id in known && (presence[it.id]?.at ?: 0) > now - FRESH_MS }
        val cur = current?.let { c -> found[c.id] }
        val mode = prefs.getString("mode", "auto")

        val pick: Found? = if (mode != "auto") {
            found[mode]
        } else if (prefer != null && found[prefer] != null) {
            found[prefer]
        } else if (cur != null && cur.id in known && isBusy() && !force) {
            cur
        } else {
            val best = reachable.minByOrNull { presence[it.id]!!.idle }
            when {
                cur == null || cur.id !in known || reachable.none { it.id == cur.id } -> best ?: cur?.takeIf { it.id in known }
                best == null || best.id == cur.id -> cur
                (presence[cur.id]?.idle ?: 0) > LEAVE_AFTER_IDLE_S &&
                    presence[best.id]!!.idle + SWITCH_MARGIN_S < (presence[cur.id]?.idle ?: 0) -> best
                else -> cur
            }
        }

        val target = pick?.let { f -> known[f.id]?.let { k -> Target(f.id, k.name, f.host, f.port, k.token) } }
        if (target != current) {
            val switched = current != null && target != null && current!!.id != target.id
            current = target
            onTarget(target)
            if (switched) onSwitched(target!!.name)
        }
        publish()
    }

    private fun publish() {
        val ids = LinkedHashSet<String>().apply { addAll(known.keys); addAll(found.keys) }
        val now = System.currentTimeMillis()
        entries.value = ids.map { id ->
            val f = found[id]
            MacEntry(
                id = id,
                name = known[id]?.name ?: f?.name ?: "Mac",
                paired = id in known,
                reachable = f != null && (id !in known || (presence[id]?.at ?: 0) > now - FRESH_MS),
                pairing = f?.pairing == true,
                current = current?.id == id,
            )
        }
        pairPrompt.value = entries.value.firstOrNull { !it.paired && it.pairing && it.id !in declined }
    }

    // ---- storage -----------------------------------------------------------

    private fun loadKnown() {
        val json = runCatching { JSONObject(prefs.getString("known", "{}")!!) }.getOrNull() ?: return
        for (id in json.keys()) {
            val o = json.getJSONObject(id)
            known[id] = Known(id, o.optString("name", "Mac"), o.getString("token"))
        }
    }

    private fun saveKnown() {
        val json = JSONObject()
        for (k in known.values) json.put(k.id, JSONObject().put("name", k.name).put("token", k.token))
        prefs.edit().putString("known", json.toString()).apply()
    }
}
