// Natif image bridge over stable-diffusion.cpp (MIT). See natif_sd.h.
#include "natif_sd.h"

#include <atomic>
#include <string>

#include "stable-diffusion.h"

#define STB_IMAGE_WRITE_STATIC
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

struct natif_sd {
  sd_ctx_t* ctx = nullptr;
};

static thread_local std::string g_error;
static void set_error(const char* where) {
  const char* e = sd_get_last_error();
  g_error = std::string(where) + (e && *e ? std::string(": ") + e : std::string());
}

const char* natif_sd_error(void) { return g_error.c_str(); }

natif_sd* natif_sd_load(const char* model_path, int n_threads) {
  g_error.clear();
  sd_ctx_opt_t* opt = sd_ctx_opt_create();
  if (!opt) { set_error("options"); return nullptr; }
  bool ok = sd_opt_set_string((sd_opt_t*)opt, "model_path", model_path) == SD_STATUS_OK;
  if (ok && n_threads > 0) ok = sd_opt_set_int((sd_opt_t*)opt, "n_threads", n_threads) == SD_STATUS_OK;
  if (!ok) { set_error("model options"); sd_opt_free((sd_opt_t*)opt); return nullptr; }
  sd_ctx_t* ctx = nullptr;
  sd_status_t st = sd_ctx_create(opt, &ctx);
  sd_opt_free((sd_opt_t*)opt);
  if (st != SD_STATUS_OK || !ctx) { set_error("load"); return nullptr; }
  natif_sd* sd = new natif_sd();
  sd->ctx = ctx;
  return sd;
}

struct progress_box { void (*cb)(int, int, void*); void* user; };
static void on_progress(int step, int steps, float, void* data) {
  auto* b = static_cast<progress_box*>(data);
  if (b && b->cb) b->cb(step, steps, b->user);
}

int natif_sd_generate(natif_sd* sd, const char* prompt, const char* negative_prompt, int width, int height, int steps,
                      float cfg_scale, long long seed, const char* out_png_path,
                      void (*progress)(int step, int steps, void* user), void* user) {
  g_error.clear();
  if (!sd || !sd->ctx) { g_error = "model not loaded"; return -1; }
  sd_img_gen_opt_t* opt = sd_img_gen_opt_create();
  sd_opt_t* o = (sd_opt_t*)opt;
  bool ok = opt && sd_opt_set_string(o, "prompt", prompt) == SD_STATUS_OK &&
            sd_opt_set_string(o, "negative_prompt", negative_prompt ? negative_prompt : "") == SD_STATUS_OK &&
            sd_opt_set_int(o, "width", width) == SD_STATUS_OK && sd_opt_set_int(o, "height", height) == SD_STATUS_OK &&
            sd_opt_set_int(o, "sample.steps", steps) == SD_STATUS_OK &&
            sd_opt_set_string(o, "sample.method", "euler_a") == SD_STATUS_OK &&
            sd_opt_set_float(o, "sample.guidance.txt_cfg", cfg_scale) == SD_STATUS_OK &&
            sd_opt_set_int(o, "seed", seed) == SD_STATUS_OK &&
            sd_opt_set_bool(o, "vae_tiling.enabled", true) == SD_STATUS_OK;
  if (!ok) { set_error("generation options"); if (opt) sd_opt_free(o); return -2; }
  progress_box box{progress, user};
  sd_set_progress_callback(on_progress, &box);
  sd_result_t* res = nullptr;
  sd_status_t st = sd_generate_image(sd->ctx, opt, &res);
  sd_set_progress_callback(nullptr, nullptr);
  sd_opt_free(o);
  if (st == SD_STATUS_CANCELLED) { g_error = "cancelled"; if (res) sd_result_free(res); return -3; }
  if (st != SD_STATUS_OK || !res || sd_result_get_image_count(res) < 1) { set_error("generate"); if (res) sd_result_free(res); return -4; }
  const sd_tensor_t* img = sd_result_get_image(res, 0);
  // Images are U8 [C, W, H], channel dimension contiguous (interleaved pixels).
  int c = (int)sd_tensor_dim(img, 0), w = (int)sd_tensor_dim(img, 1), h = (int)sd_tensor_dim(img, 2);
  if (sd_tensor_type(img) != SD_TENSOR_U8 || c < 1 || w < 1 || h < 1) { g_error = "unexpected image format"; sd_result_free(res); return -5; }
  int wrote = stbi_write_png(out_png_path, w, h, c, sd_tensor_data(img), w * c);
  sd_result_free(res);
  if (!wrote) { g_error = std::string("could not write ") + out_png_path; return -6; }
  return 0;
}

void natif_sd_cancel(natif_sd* sd) {
  if (sd && sd->ctx) sd_cancel_generation(sd->ctx, SD_CANCEL_ALL);
}

void natif_sd_free(natif_sd* sd) {
  if (!sd) return;
  if (sd->ctx) sd_ctx_free(sd->ctx);
  delete sd;
}
