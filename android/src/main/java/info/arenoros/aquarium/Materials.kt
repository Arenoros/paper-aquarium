package info.arenoros.aquarium

import android.content.Context
import android.util.Log
import com.google.android.filament.Engine
import com.google.android.filament.Material
import com.google.android.filament.filamat.MaterialBuilder
import com.google.android.filament.filamat.MaterialBuilder.ParameterPrecision
import com.google.android.filament.filamat.MaterialBuilder.SamplerFormat
import com.google.android.filament.filamat.MaterialBuilder.SamplerType
import com.google.android.filament.filamat.MaterialBuilder.UniformType
import com.google.android.filament.filamat.MaterialBuilder.Variable
import com.google.android.filament.filamat.MaterialBuilder.VertexAttribute
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

// Материалы сцены. Компилирует их filamat прямо на ТВ (matc есть только
// в 855-мегабайтном архиве под Windows), один раз: готовый пакет ложится
// в files/materials/ под хешем исходника и со следующего запуска читается
// за миллисекунды вместо ~5 с компиляции.
//
// Освещение своё, не PBR Filament: на Mali-G52 тот стоил ~44 мс кадра.
// Свет, туман и ACES те же, что у сайта, но по дешёвым формулам, а пост-
// прохода у Filament нет вовсе — кадр собирается за один проход, как у
// three.js (docs/adr/0002-native-filament-on-tv.md).
class Materials(private val ctx: Context, private val engine: Engine) {
    val painted by lazy { fish("painted", planar = true) }
    val textured by lazy { fish("textured", planar = false) }
    val food by lazy {
        load("food", "$TONE_GLSL\n$FOOD_FRAGMENT", "") {
            it.shading(MaterialBuilder.Shading.UNLIT)
                .uniformParameter(UniformType.FLOAT3, "color")
        }
    }
    val background by lazy {
        load("background", "$TONE_GLSL\n$BACKGROUND_FRAGMENT", "") {
            it.shading(MaterialBuilder.Shading.UNLIT)
                .depthWrite(false)
                .culling(MaterialBuilder.CullingMode.NONE)
                .require(VertexAttribute.UV0)
                .uniformParameter(UniformType.FLOAT4, "uvFit")
                .samplerParameter(SamplerType.SAMPLER_2D, SamplerFormat.FLOAT, ParameterPrecision.DEFAULT, "map")
        }
    }

    // Раскрашенная рыбка — рисунок по планарной развёртке бокового силуэта;
    // готовая — заводская текстура по UV модели.
    private fun fish(name: String, planar: Boolean): Material {
        val uvVertex = if (planar)
            "material.planar = vec4(dot(materialParams.uvU, vec4(p, 1.0)), 1.0 - dot(materialParams.uvV, vec4(p, 1.0)), 0.0, 0.0);"
        else ""
        val uv = if (planar) "variable_planar.xy" else "getUV0()"
        return load(name, FISH_FRAGMENT.replace("UV_COORD", uv), FISH_VERTEX.replace("UV_VERTEX", uvVertex)) { b ->
            b.shading(MaterialBuilder.Shading.UNLIT)
                .doubleSided(true)
                .require(VertexAttribute.POSITION)
                .require(VertexAttribute.TANGENTS)
                .uniformParameter(UniformType.FLOAT4, "bodyMask")   // xyz — ось тела, w — фаза изгиба
                .uniformParameter(UniformType.FLOAT4, "latMask")    // xyz — ось бока, w — размах изгиба (0 — клип гнёт сам)
                .uniformParameter(UniformType.FLOAT4, "bendRange")  // x, y — тело вдоль оси, z — голова у max
                .samplerParameter(SamplerType.SAMPLER_2D, SamplerFormat.FLOAT, ParameterPrecision.DEFAULT, "baseColorMap")
                .variable(Variable.CUSTOM1, "wn")
                .variable(Variable.CUSTOM2, "light")
                .also {
                    if (planar) it.uniformParameter(UniformType.FLOAT4, "uvU").uniformParameter(UniformType.FLOAT4, "uvV")
                        .variable(Variable.CUSTOM0, "planar")
                    else it.require(VertexAttribute.UV0).flipUV(true)
                }
        }
    }

    private fun load(name: String, fragment: String, vertex: String, setup: (MaterialBuilder) -> MaterialBuilder): Material {
        val dir = File(ctx.filesDir, "materials").apply { mkdirs() }
        val hash = (FILAMENT + name + fragment + vertex).hashCode().toUInt().toString(16)
        val file = File(dir, "$name-$hash.filamat")
        val bytes = if (file.exists()) file.readBytes() else {
            val t0 = System.currentTimeMillis()
            if (!builderReady) { MaterialBuilder.init(); builderReady = true }
            val b = setup(MaterialBuilder().name(name))
            if (vertex.isNotEmpty()) b.materialVertex(vertex)
            val pkg = b.material(fragment)
                .platform(MaterialBuilder.Platform.MOBILE)
                .targetApi(MaterialBuilder.TargetApi.OPENGL)
                .optimization(MaterialBuilder.Optimization.PERFORMANCE)
                .build()
            check(pkg.isValid) { "материал $name не собрался" }
            val out = ByteArray(pkg.buffer.remaining()).also { pkg.buffer.get(it) }
            dir.listFiles { f -> f.name.startsWith("$name-") }?.forEach { it.delete() }
            file.writeBytes(out)
            Log.i("aqua", "материал $name скомпилирован за ${System.currentTimeMillis() - t0} мс")
            out
        }
        val buf = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).put(bytes).flip() as ByteBuffer
        return Material.Builder().payload(buf, buf.remaining()).build(engine)
    }

    companion object {
        private var builderReady = false
        // меняется с версией Filament — тогда пакеты пересобираются
        private const val FILAMENT = "1.77.3"
    }
}

// Каустика сайта (CAUSTIC_GLSL в realistic-tank.html), считается по вершинам:
// рябь меняется на масштабе ~1 единицы, а вершины рыбы стоят через 0.04–0.1 —
// на глаз то же, а в разы дешевле, чем по пикселям. Затухание и конус
// прожектора — тоже по вершинам. highp: время растёт без предела.
private const val VERTEX_LIGHT_GLSL = """
float causticPattern(highp vec2 p, highp float t) {
    highp vec2 q = p * 0.55;
    float c = 0.0;
    for (int i = 0; i < 3; i++) {
        highp float fi = float(i) + 1.0;
        q += 0.42 * vec2(sin(q.y * 1.35 + t * 1.05 * fi), cos(q.x * 1.6 + t * 0.9 * fi));
        c += 0.32 / (abs(sin(q.x) * sin(q.y)) * 3.3 + 0.32);
    }
    return pow(clamp(c * 0.16, 0.0, 1.0), 2.5);
}
// выше от дна каустика слабее — свет уже рассеялся (LIT_DEPTH 12.4)
float causticTerm(highp vec3 wp, highp float time) {
    return causticPattern(wp.xz, time * 0.35) * 0.5 * (1.0 - clamp(wp.y / 12.4, 0.0, 1.0) * 0.65);
}
// SpotLight(0xe8f7ff, 3.4, 48, 0.62, 0.42, 1.1) из (0, 15.2, −1.5) в (0, 0, 0)
float spotK(highp vec3 wp) {
    highp vec3 toL = vec3(0.0, 15.2, -1.5) - wp;
    float dist = length(toL);
    float cone = smoothstep(0.8139, 0.9359, dot(-toL / dist, vec3(0.0, -0.9952, 0.0982)));
    return cone * pow(clamp(1.0 - dist / 48.0, 0.0, 1.0), 1.1);
}
"""

private const val FISH_VERTEX = VERTEX_LIGHT_GLSL + """
void materialVertex(inout MaterialVertexInputs material) {
    vec3 p = getPosition().xyz;
    UV_VERTEX
    // Изгиб тела, если клип его не гнёт (addBend сайта): волна от головы к хвосту.
    float amp = materialParams.latMask.w;
    if (amp > 0.0) {
        float a = dot(p, materialParams.bodyMask.xyz);
        float span = max(materialParams.bendRange.y - materialParams.bendRange.x, 0.0001);
        float k = materialParams.bendRange.z > 0.5 ? (materialParams.bendRange.y - a) / span
                                                   : (a - materialParams.bendRange.x) / span;
        k = clamp(k, 0.0, 1.0); k *= k;
        float w = sin(getUserTime().x * 5.5 + materialParams.bodyMask.w + k * 3.2) * amp * k * span * 0.25;
        material.worldPosition.xyz += (getWorldFromModelMatrix() * vec4(materialParams.latMask.xyz * w, 0.0)).xyz;
    }
    // Нормаль со скиннингом — unlit-материалу Filament её сам не считает.
    vec3 n;
    toTangentFrame(mesh_tangents, n);
#if defined(VARIANT_HAS_SKINNING_OR_MORPHING)
    if ((object_uniforms_flagsChannels & FILAMENT_OBJECT_SKINNING_ENABLED_BIT) != 0)
        skinNormal(n, mesh_bone_indices, mesh_bone_weights);
#endif
    material.wn = vec4(getWorldFromModelNormalMatrix() * n, 0.0);
    highp vec3 wp = mulMat4x4Float3(getUserWorldFromWorldMatrix(), material.worldPosition.xyz).xyz;
    material.light = vec4(causticTerm(wp, getUserTime().x), spotK(wp), 0.0, 0.0);
}
"""

// Свет buildLights() сайта (three r128 без physicallyCorrectLights: π сокращается,
// вклад = albedo · цвет · сила · N·L). Блик GGX при roughness 0.55 (α = 0.3025)
// заменён Blinn с той же шириной (n ≈ 2/α² − 2 ≈ 20) и тем же пиком
// (F·Vis/α² ≈ 2.7·F). Окружение — «комната» × envMapIntensity 0.5 как полусфера.
private const val CHEAP_LIGHT_GLSL = """
vec3 cheapLight(vec3 albedo, vec3 n, vec3 v, highp vec3 wp, float spot) {
    const vec3 L1 = vec3(0.4835, 0.3223, 0.8058);            // DirectionalLight из (12, 8, 20)
    const vec3 C1 = vec3(0.6235, 0.7882, 0.8784) * 0.35;     // 0x9fc9e0, 0.35
    vec3 L2 = normalize(vec3(0.0, 15.2, -1.5) - wp);         // SpotLight
    vec3 C2 = vec3(0.9098, 0.9686, 1.0) * (3.4 * spot);      // 0xe8f7ff, 3.4
    float nl1 = max(dot(n, L1), 0.0);
    float nl2 = max(dot(n, L2), 0.0);
    float nv = max(dot(n, v), 0.0);
    vec3 amb = mix(vec3(0.20), vec3(0.42), n.y * 0.5 + 0.5) + vec3(0.021, 0.033, 0.043);
    vec3 diff = albedo * 0.95 * (amb + C1 * nl1 + C2 * nl2);
    float s1 = pow(max(dot(n, normalize(L1 + v)), 0.0), 20.0) * nl1;
    float s2 = pow(max(dot(n, normalize(L2 + v)), 0.0), 20.0) * nl2;
    float F = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    return diff + (C1 * s1 + C2 * s2) * (2.7 * F) + vec3(0.3) * F;
}
"""

// ACESFilmicToneMapping (toneMappingExposure 0.92), LinearTosRGB и линейный
// Fog(0x2e86a8, 14, 60) из three r128: пост-прохода нет, всё в шейдере.
private const val TONE_GLSL = """
vec3 acesFilmic(vec3 color) {
    const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    color *= 0.92 / 0.6;
    color = inM * color;
    vec3 a = color * (color + 0.0245786) - 0.000090537;
    vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
    return clamp(outM * (a / b), 0.0, 1.0);
}
vec3 toSrgb(vec3 c) {
    return mix(pow(c, vec3(0.41666)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}
vec3 finish(vec3 linear, highp vec3 wp) {
    return mix(toSrgb(acesFilmic(linear)), vec3(0.1804, 0.5255, 0.6588), smoothstep(14.0, 60.0, 17.5 - wp.z));
}
"""

private const val FISH_FRAGMENT = CHEAP_LIGHT_GLSL + TONE_GLSL + """
void material(inout MaterialInputs material) {
    prepareMaterial(material);
    vec3 albedo = texture(materialParams_baseColorMap, UV_COORD).rgb + vec3(0.45, 0.72, 0.85) * variable_light.x;
    vec3 n = normalize(variable_wn.xyz);
    if (!gl_FrontFacing) n = -n;
    highp vec3 wp = getUserWorldPosition();
    vec3 v = normalize(vec3(0.0, 6.5, 17.5) - wp);
    material.baseColor = vec4(finish(cheapLight(albedo, n, v, wp, variable_light.y), wp), 1.0);
}
"""

// Корм: MeshStandardMaterial(0xd2913f, roughness 0.9, emissive 0x63421a × 0.6) —
// крупинка в несколько пикселей, свет на ней не разглядеть.
private const val FOOD_FRAGMENT = """
void material(inout MaterialInputs material) {
    prepareMaterial(material);
    highp vec3 wp = getUserWorldPosition();
    material.baseColor = vec4(finish(materialParams.color, wp), 1.0);
}
"""

// Фон на сайте тоже проходит ACES — значит, и здесь; тумана на нём нет.
private const val BACKGROUND_FRAGMENT = """
void material(inout MaterialInputs material) {
    prepareMaterial(material);
    vec4 c = texture(materialParams_map, getUV0() * materialParams.uvFit.xy + materialParams.uvFit.zw);
    material.baseColor = vec4(toSrgb(acesFilmic(c.rgb)), 1.0);
}
"""
