data class Telemetry(
    val uptimeMs: Int,
    var status: String
)

class Config {
    val id: Long? = null
    var isActive: Boolean = false
}

class Matrix(
    val tags: List<String>,
    val bytes: ByteArray,
    val counts: IntArray
)

enum class Status { Idle, Active }

private class Hidden {}
class Visible {
    private val secret: Int = 1
    val publicValue: Int = 2
}