/*
 * glslc_shim.c — the subset of glslc the dreamcomp renderer's CMake needs.
 *
 *   glslc_shim --target-env=vulkan1.1 -O -mfmt=c -o OUT.inc IN.vert
 *
 * Why this exists: macOS here has no Vulkan SDK and installing one is out of scope. The machine
 * already carries libshaderc (mpv bundles it), which is the compiler glslc itself wraps. This
 * program drives its stable C API and writes the same `-mfmt=c` brace list that
 * engine/render/cmake/wrap_spirv.cmake wraps into a C++ header.
 *
 * Build with tools/setup_glslc.sh. Only the C API is declared here, so no shaderc headers are
 * needed in the repository.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void* shaderc_compiler_t;
typedef void* shaderc_compile_options_t;
typedef void* shaderc_compilation_result_t;

/* libshaderc/include/shaderc/shaderc.h and env.h */
enum {
    shaderc_vertex_shader = 0,
    shaderc_fragment_shader = 1,
    shaderc_compute_shader = 2,
    shaderc_geometry_shader = 3,
    shaderc_tess_control_shader = 4,
    shaderc_tess_evaluation_shader = 5,
};
enum { shaderc_target_env_vulkan = 0 };
enum { shaderc_optimization_level_performance = 2 };
#define SHADERC_ENV_VULKAN_1_1 ((1u << 22) | (1u << 12))

extern shaderc_compiler_t shaderc_compiler_initialize(void);
extern void shaderc_compiler_release(shaderc_compiler_t);
extern shaderc_compile_options_t shaderc_compile_options_initialize(void);
extern void shaderc_compile_options_release(shaderc_compile_options_t);
extern void shaderc_compile_options_set_target_env(shaderc_compile_options_t, int, uint32_t);
extern void shaderc_compile_options_set_optimization_level(shaderc_compile_options_t, int);
extern shaderc_compilation_result_t shaderc_compile_into_spv(
    shaderc_compiler_t, const char*, size_t, int, const char*, const char*,
    shaderc_compile_options_t);
extern int shaderc_result_get_compilation_status(shaderc_compilation_result_t);
extern const char* shaderc_result_get_error_message(shaderc_compilation_result_t);
extern size_t shaderc_result_get_length(shaderc_compilation_result_t);
extern const char* shaderc_result_get_bytes(shaderc_compilation_result_t);
extern void shaderc_result_release(shaderc_compilation_result_t);

static int fail(const char* what, const char* detail) {
    fprintf(stderr, "glslc(shim): %s%s%s\n", what, detail ? ": " : "", detail ? detail : "");
    return 1;
}

static int stage_for(const char* path, const char* forced) {
    const char* ext = forced ? forced : strrchr(path, '.');
    if (!ext) return -1;
    if (forced) {
        /* -fshader-stage=vert */
        if (!strcmp(ext, "vert")) return shaderc_vertex_shader;
        if (!strcmp(ext, "frag")) return shaderc_fragment_shader;
        if (!strcmp(ext, "comp")) return shaderc_compute_shader;
        if (!strcmp(ext, "geom")) return shaderc_geometry_shader;
        if (!strcmp(ext, "tesc")) return shaderc_tess_control_shader;
        if (!strcmp(ext, "tese")) return shaderc_tess_evaluation_shader;
        return -1;
    }
    if (!strcmp(ext, ".vert")) return shaderc_vertex_shader;
    if (!strcmp(ext, ".frag")) return shaderc_fragment_shader;
    if (!strcmp(ext, ".comp")) return shaderc_compute_shader;
    if (!strcmp(ext, ".geom")) return shaderc_geometry_shader;
    if (!strcmp(ext, ".tesc")) return shaderc_tess_control_shader;
    if (!strcmp(ext, ".tese")) return shaderc_tess_evaluation_shader;
    return -1;
}

static char* read_file(const char* path, size_t* len) {
    FILE* f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0) {
        fclose(f);
        return NULL;
    }
    char* buf = (char*)malloc((size_t)n + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[got] = '\0';
    *len = got;
    return buf;
}

int main(int argc, char** argv) {
    const char* input = NULL;
    const char* output = NULL;
    const char* forced_stage = NULL;
    int optimize = 0;

    for (int i = 1; i < argc; ++i) {
        const char* a = argv[i];
        if (!strcmp(a, "-o") && i + 1 < argc) {
            output = argv[++i];
        } else if (!strncmp(a, "-o", 2)) {
            output = a + 2;
        } else if (!strcmp(a, "-O")) {
            optimize = 1;
        } else if (!strncmp(a, "-fshader-stage=", 15)) {
            forced_stage = a + 15;
        } else if (a[0] == '-') {
            /* -mfmt=c, --target-env=..., and anything else: accepted and ignored. */
        } else {
            input = a;
        }
    }
    if (!input) return fail("no input file", NULL);
    if (!output) return fail("no -o output file", NULL);

    const int stage = stage_for(input, forced_stage);
    if (stage < 0) return fail("cannot infer shader stage", input);

    size_t source_len = 0;
    char* source = read_file(input, &source_len);
    if (!source) return fail("cannot read", input);

    shaderc_compiler_t compiler = shaderc_compiler_initialize();
    if (!compiler) {
        free(source);
        return fail("shaderc_compiler_initialize failed", NULL);
    }
    shaderc_compile_options_t options = shaderc_compile_options_initialize();
    if (!options) {
        shaderc_compiler_release(compiler);
        free(source);
        return fail("shaderc_compile_options_initialize failed", NULL);
    }
    shaderc_compile_options_set_target_env(options, shaderc_target_env_vulkan,
                                           SHADERC_ENV_VULKAN_1_1);
    if (optimize)
        shaderc_compile_options_set_optimization_level(options,
                                                       shaderc_optimization_level_performance);

    const char* base = strrchr(input, '/');
    base = base ? base + 1 : input;
    shaderc_compilation_result_t result = shaderc_compile_into_spv(
        compiler, source, source_len, stage, base, "main", options);
    free(source);
    if (!result) {
        shaderc_compile_options_release(options);
        shaderc_compiler_release(compiler);
        return fail("shaderc_compile_into_spv failed", NULL);
    }
    if (shaderc_result_get_compilation_status(result) != 0) {
        fprintf(stderr, "%s\n", shaderc_result_get_error_message(result));
        shaderc_result_release(result);
        shaderc_compile_options_release(options);
        shaderc_compiler_release(compiler);
        return 1;
    }

    const size_t len = shaderc_result_get_length(result);
    const unsigned char* bytes = (const unsigned char*)shaderc_result_get_bytes(result);
    FILE* out = fopen(output, "wb");
    if (!out) {
        shaderc_result_release(result);
        shaderc_compile_options_release(options);
        shaderc_compiler_release(compiler);
        return fail("cannot write", output);
    }
    fputc('{', out);
    for (size_t i = 0; i + 3 < len; i += 4) {
        uint32_t w = (uint32_t)bytes[i] | ((uint32_t)bytes[i + 1] << 8) |
                     ((uint32_t)bytes[i + 2] << 16) | ((uint32_t)bytes[i + 3] << 24);
        fprintf(out, "%s0x%08x", i ? "," : "", w);
    }
    fputs("}\n", out);
    fclose(out);

    shaderc_result_release(result);
    shaderc_compile_options_release(options);
    shaderc_compiler_release(compiler);
    return 0;
}
