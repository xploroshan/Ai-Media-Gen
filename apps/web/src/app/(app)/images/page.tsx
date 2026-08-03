import { ImageStudioClient } from "@/components/images/image-studio-client";

export default function ImagesPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Image Studio</h1>
      <p className="mb-6 text-sm text-muted">
        Enhance, remove backgrounds, erase objects and upscale. Every fix creates a new image —
        originals stay untouched.
      </p>
      <ImageStudioClient />
    </div>
  );
}
