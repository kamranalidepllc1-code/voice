import TextToSpeech from "@/components/tts/TextToSpeech";

export default function Home() {
  return (
    <div className="flex flex-1 justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-4xl flex-col gap-8 bg-white px-4 py-12 sm:px-10 sm:py-16 dark:bg-black">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">Text to Speech</h1>
          <p className="max-w-2xl text-base leading-7 text-zinc-600 dark:text-zinc-400">
            Turn up to 4,000 words into natural-sounding narration with Google Gemini voices, then listen or download the audio.
          </p>
        </header>
        <TextToSpeech />
      </main>
    </div>
  );
}
