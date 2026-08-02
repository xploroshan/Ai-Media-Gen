export default function LibraryPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold">Library</h1>
      <p className="text-sm text-muted" data-testid="library-empty">
        Your media library is empty. Upload photos and videos to get started.
      </p>
    </div>
  );
}
