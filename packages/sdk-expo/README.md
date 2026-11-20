# @be-natif/expo

On-device AI for Expo dev builds: resumable model downloads, memory config plugin, same API as @be-natif/web.

```bash
npx expo install @be-natif/expo llama.rn expo-file-system expo-device @react-native-async-storage/async-storage
```

## Images on the device

```ts
import { createClient } from "@be-natif/expo";
import { Image } from "react-native";

const ai = createClient();
// First call downloads the image model once (~2 GB, resumable), then it's cached.
const { uri } = await ai.image({ prompt: "pixel art knight, white background" });
<Image source={{ uri }} style={{ width: 384, height: 384 }} />;
```

- Runs [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (MIT): Metal on iOS, CPU on Android (arm64).
- Default model: SD-Turbo q8, 384×384, 4 steps. Peak memory ≈ 2.5 GB, so only one large model stays loaded: `image()` frees the text model and the next text call frees the image model.
- `ai.downloadImageModel()` pre-downloads it (e.g. on Wi-Fi during onboarding). `seed` makes results repeatable.
- Model license: SD-Turbo is under the [Stability AI Community License](https://stability.ai/community-license-agreement) (free under USD 1M yearly revenue; register with Stability and credit "Powered by Stability AI"). Pass `imageModel` to use another stable-diffusion.cpp GGUF.
- Needs a development build (not Expo Go). iOS simulator: Apple Silicon (arm64) only.

Part of **Natif**, the on-device AI SDK: describe the task, not the model. Natif picks the model that fits each device, runs it locally and validates the output.

- Docs: https://benatif.com/docs/
- Playground (runs in your browser): https://benatif.com/playground/
- Source: https://github.com/adanzweig/natif

License: Apache-2.0
