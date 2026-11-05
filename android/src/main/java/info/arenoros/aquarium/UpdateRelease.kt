package info.arenoros.aquarium

import org.json.JSONObject

internal const val UPDATE_REPO = "Arenoros/paper-aquarium"
private const val MAX_APK_SIZE = 256 * 1024 * 1024L
private val releaseTag = Regex("""v(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]?)""")
private val sha256 = Regex("""sha256:[0-9a-f]{64}""")

internal data class UpdateRelease(val version: String, val code: Long, val url: String, val size: Long, val digest: String)

internal fun parseRelease(json: JSONObject, installedCode: Long): UpdateRelease? {
    if (json.optBoolean("draft") || json.optBoolean("prerelease")) return null
    val tag = json.optString("tag_name")
    val (major, minor, patch) = releaseTag.matchEntire(tag)?.destructured ?: return null
    val code = major.toLong() * 10_000 + minor.toLong() * 100 + patch.toLong()
    if (code <= installedCode) return null
    val version = tag.removePrefix("v")
    val name = "paper-aquarium-tv-$version.apk"
    val url = "https://github.com/$UPDATE_REPO/releases/download/$tag/$name"
    val assets = json.optJSONArray("assets") ?: return null
    for (i in 0 until assets.length()) {
        val asset = assets.optJSONObject(i) ?: continue
        if (asset.optString("name") != name || asset.optString("browser_download_url") != url) continue
        val size = asset.optLong("size")
        val digest = asset.optString("digest")
        if (size in 1..MAX_APK_SIZE && sha256.matches(digest)) return UpdateRelease(version, code, url, size, digest)
    }
    return null
}
