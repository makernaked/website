import type { Metadata } from "next";
import StringArtLoader from "@/string-art/StringArtLoader";

export const metadata: Metadata = {
  title: "String Art Nail Planner · Maker Naked",
  description: "Lay out vector artwork, calculate an optimal nailing pattern and stringing order, and print a full-size template.",
};

export default function StringArtPage() {
  return <StringArtLoader />;
}
