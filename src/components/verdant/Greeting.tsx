"use client";

import { useEffect, useState } from "react";

function pickGreeting(hour: number): string {
  if (hour >= 5 && hour <= 7) return "Up early";
  if (hour >= 8 && hour <= 11) return "Good morning";
  if (hour >= 12 && hour <= 16) return "Good afternoon";
  if (hour >= 17 && hour <= 20) return "Good evening";
  return "Tending late";
}

export function Greeting({ name }: { name: string }) {
  const [phrase, setPhrase] = useState<string | null>(null);
  useEffect(() => {
    setPhrase(pickGreeting(new Date().getHours()));
  }, []);
  return (
    <>
      {phrase ?? "Hello"},{" "}
      <span style={{ fontStyle: "italic", color: "var(--moss-deep)" }}>
        {name}
      </span>
      .
    </>
  );
}
