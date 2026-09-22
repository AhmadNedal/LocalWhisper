# Local model cache

Whisper models (CTranslate2 format) are downloaded here **once**, the first time
you use them, and then loaded from disk — transcription works offline afterwards.

- One folder per model, e.g. `models/large-v3-turbo/`.
- A `.complete` marker is written when a download finishes; an interrupted
  download is resumed automatically next time.
- Delete a model from the app (trash icon) or simply delete its folder.

The packaged Windows app stores models in `%LOCALAPPDATA%\Local Transcriber\models`
instead of this folder.
