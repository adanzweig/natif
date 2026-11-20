// Natif image bridge: a tiny C API over stable-diffusion.cpp, shared by iOS and Android.
#pragma once
#ifdef __cplusplus
extern "C" {
#endif

typedef struct natif_sd natif_sd;

/** Loads a GGUF diffusion model (e.g. SD-Turbo). Returns NULL on failure; see natif_sd_error(). */
natif_sd* natif_sd_load(const char* model_path, int n_threads);

/**
 * Text → image, written as PNG to out_png_path. Returns 0 on success.
 * steps: 1-4 for turbo models; cfg_scale: 1.0 for turbo models; seed < 0 = random.
 * progress (optional) is called with (step, steps, user).
 */
int natif_sd_generate(natif_sd* sd, const char* prompt, const char* negative_prompt, int width, int height, int steps,
                      float cfg_scale, long long seed, const char* out_png_path,
                      void (*progress)(int step, int steps, void* user), void* user);

/** Stops a generation in progress (safe from another thread). */
void natif_sd_cancel(natif_sd* sd);

void natif_sd_free(natif_sd* sd);

/** Last error message on this thread ("" if none). */
const char* natif_sd_error(void);

#ifdef __cplusplus
}
#endif
