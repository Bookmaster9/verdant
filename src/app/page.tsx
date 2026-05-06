import { Shell } from "@/components/Shell";
import Link from "next/link";
import {
  Bird,
  Cloud,
  Frog,
  GoogleG,
  HeroTree,
  Mushroom,
  Snail,
  Sparkle,
  Sprout,
  SunArt,
  WateringCan,
} from "@/components/verdant/art";
import { prisma } from "@/lib/db";

// Counter is a per-request DB read; opt out of static rendering so the
// landing page reflects the current total on every visit.
export const dynamic = "force-dynamic";

async function getSproutTotal(): Promise<number> {
  try {
    const row = await prisma.sproutCounter.findUnique({ where: { id: 1 } });
    return row?.total ?? 0;
  } catch {
    return 0;
  }
}

const PILLARS = [
  {
    icon: <Sprout size={88} growth={0.55} />,
    kicker: "01 — plant",
    title: "Tell us what to grow",
    body:
      "Drop a goal, a deadline, a few starter resources. We map it into phases — foundations, drills, milestones — using how people actually learn.",
  },
  {
    icon: <WateringCan size={88} />,
    kicker: "02 — water",
    title: "We pour it into your week",
    body:
      "Verdant looks at your Google calendar, your time windows, and the pace you can sustain. Then it places sessions into open soil — never too much, never too little.",
  },
  {
    icon: <Mushroom size={88} />,
    kicker: "03 — harvest",
    title: "Reflect, and it adapts",
    body:
      "Rate sessions, mark misses, talk to Fern in plain language. Skip a Thursday? She'll redistribute, not just nudge. Best slots learn themselves.",
  },
];

export default async function Home() {
  const sproutTotal = await getSproutTotal();
  return (
    <Shell showHelper={false} showFooter={false}>
      <div style={{ position: "relative", padding: "0 36px 36px" }}>
        <div style={{ position: "absolute", top: 12, left: 60, opacity: 0.85 }}>
          <Cloud size={140} style={{ animation: "float 9s ease-in-out infinite" }} />
        </div>
        <div style={{ position: "absolute", top: 80, right: 100 }}>
          <SunArt size={88} className="float-y" />
        </div>
        <div style={{ position: "absolute", top: 60, left: 360 }}>
          <Bird size={36} />
        </div>
        <div style={{ position: "absolute", top: 150, right: 380 }}>
          <Bird size={28} />
        </div>

        <div className="journal-edge" style={{ padding: "60px 80px 40px", marginTop: 12 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.2fr 1fr",
              gap: 56,
              alignItems: "center",
            }}
          >
            <div>
              <div className="tag" style={{ marginBottom: 14 }}>
                a garden journal for self-learners
              </div>
              <h1
                className="serif-display"
                style={{
                  fontSize: 84,
                  lineHeight: 0.95,
                  margin: "0 0 18px",
                  fontWeight: 400,
                  letterSpacing: "-0.02em",
                  fontVariationSettings: '"opsz" 144',
                }}
              >
                Plant a goal.
                <br />
                <span style={{ fontStyle: "italic", color: "var(--moss-deep)" }}>
                  Tend it
                </span>{" "}
                until
                <br />
                it{" "}
                <span className="hand" style={{ fontSize: 72, color: "var(--berry)" }}>
                  blooms
                </span>
                .
              </h1>
              <p
                style={{
                  fontSize: 19,
                  lineHeight: 1.55,
                  color: "var(--ink-soft)",
                  maxWidth: 540,
                  margin: "0 0 28px",
                }}
              >
                Verdant takes a sprawling goal — learn to flare, hold a Korean coffee chat, paint
                watercolors — and gently plants it across the open patches of your week. As you
                practice, the plan grows with you.
              </p>
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <Link
                  href="/login"
                  className="btn primary"
                  style={{ fontSize: 16, padding: "12px 22px" }}
                >
                  <GoogleG size={18} /> sign in with Google
                </Link>
                <Link href="/dashboard" className="btn ghost" style={{ fontSize: 15 }}>
                  peek at the demo →
                </Link>
              </div>
              <div style={{ display: "flex", gap: 18, marginTop: 24, alignItems: "center" }}>
                <div style={{ display: "flex" }}>
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: [
                          "var(--sun-soft)",
                          "var(--blush)",
                          "var(--sky-soft)",
                          "var(--leaf-pale)",
                        ][i],
                        border: "1.5px solid var(--ink)",
                        marginLeft: i ? -8 : 0,
                        display: "grid",
                        placeItems: "center",
                        fontFamily: "var(--font-fraunces)",
                        fontWeight: 600,
                        fontSize: 13,
                      }}
                    >
                      {["M", "K", "T", "A"][i]}
                    </div>
                  ))}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-fraunces)",
                    fontStyle: "italic",
                    fontSize: 14,
                    color: "var(--ink-faded)",
                  }}
                >
                  {sproutTotal.toLocaleString()}{" "}
                  {sproutTotal === 1 ? "sprout" : "sprouts"} in the ground
                  this season
                </div>
              </div>
            </div>

            <div style={{ position: "relative", height: 460 }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <div className="sway" style={{ transformOrigin: "50% 90%" }}>
                  <HeroTree size={360} />
                </div>
              </div>
              <div style={{ position: "absolute", left: 4, bottom: 24 }}>
                <Snail size={84} />
              </div>
              <div style={{ position: "absolute", right: -10, bottom: 36 }}>
                <Frog size={78} />
              </div>
              <div style={{ position: "absolute", right: 80, top: 30 }}>
                <Mushroom size={56} />
              </div>
              <div style={{ position: "absolute", left: 30, top: 60 }}>
                <Sparkle size={20} />
              </div>
              <div style={{ position: "absolute", right: 30, top: 110 }}>
                <Sparkle size={14} />
              </div>
              <div
                style={{
                  position: "absolute",
                  left: -20,
                  top: 200,
                  fontFamily: "var(--font-fraunces)",
                  fontStyle: "italic",
                  fontSize: 14,
                  color: "var(--ink-faded)",
                  transform: "rotate(-7deg)",
                }}
              >
                ← every sprout has
                <br />
                its own little spirit
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 48 }}>
          <div className="divider-vine" />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 28,
            marginTop: 32,
          }}
        >
          {PILLARS.map((c, i) => (
            <div key={i} className="ink-card" style={{ padding: 24, position: "relative" }}>
              <div className="tape" style={{ left: 18, top: -10, transform: "rotate(-4deg)" }} />
              <div style={{ marginBottom: 14 }}>{c.icon}</div>
              <div className="tag" style={{ marginBottom: 6 }}>
                {c.kicker}
              </div>
              <h3
                className="serif-display"
                style={{ fontSize: 24, margin: "0 0 8px", fontWeight: 500 }}
              >
                {c.title}
              </h3>
              <p
                style={{
                  fontSize: 15,
                  lineHeight: 1.55,
                  color: "var(--ink-soft)",
                  margin: 0,
                }}
              >
                {c.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  );
}
