import { Shell } from "@/components/Shell";

export const metadata = {
  title: "Terms — Verdant",
};

export default function Terms() {
  return (
    <Shell showHelper={false} showFooter={false}>
      <div
        style={{
          padding: "48px 36px 80px",
          maxWidth: 720,
          margin: "0 auto",
        }}
      >
        <h1
          className="serif-display"
          style={{ fontSize: 36, margin: "0 0 8px", fontWeight: 500 }}
        >
          terms
        </h1>
        <p
          className="hand"
          style={{ color: "var(--ink-soft)", fontSize: 14, margin: "0 0 32px" }}
        >
          Last updated: May 5, 2026
        </p>

        <Section title="What this is">
          Verdant is a student project from MIT 6.C395. It is provided free of
          charge for personal, non-commercial learning. It is not a finished
          product and may change, break, or go offline without notice.
        </Section>

        <Section title="Your content">
          You own the goals, journal entries, and notes you create in Verdant.
          By using the app you grant us permission to store and process them
          for the sole purpose of running the service for you.
        </Section>

        <Section title="Acceptable use">
          Don&apos;t use Verdant to harass others, generate disallowed content
          via the AI tutor, or attempt to access accounts that aren&apos;t
          yours. We may remove access if you do.
        </Section>

        <Section title="No warranty">
          The app is provided &ldquo;as is&rdquo;, without warranty of any
          kind. The schedules and plans Verdant generates are suggestions, not
          professional advice. We are not liable for missed deadlines, lost
          data, or anything else that goes wrong while you use it.
        </Section>

        <Section title="Contact">
          Questions:{" "}
          <a href="mailto:lwl@mit.edu" style={{ color: "var(--ink)" }}>
            lwl@mit.edu
          </a>
          .
        </Section>
      </div>
    </Shell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ margin: "0 0 28px" }}>
      <h2
        className="serif-display"
        style={{ fontSize: 20, margin: "0 0 8px", fontWeight: 500 }}
      >
        {title}
      </h2>
      <p
        className="hand"
        style={{ color: "var(--ink-soft)", fontSize: 15, lineHeight: 1.6, margin: 0 }}
      >
        {children}
      </p>
    </section>
  );
}
