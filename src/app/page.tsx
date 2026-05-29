import Image from "next/image"

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-black text-white">
      <div className="text-center">
        <Image
          src="/makernaked-fern.svg" // replace with your logo svg when ready
          alt="Maker Naked logo"
          width={512}
          height={512}
          priority
          className="mx-auto"
        />

        <p className="mt-6 text-4xl tracking-wide text-neutral-400 font-title ">
          coming soon
        </p>
      </div>
    </main>
  )
}