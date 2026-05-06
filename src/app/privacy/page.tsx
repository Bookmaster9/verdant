import { Shell } from "@/components/Shell";

export const metadata = {
  title: "Privacy — Verdant",
};

export default function Privacy() {
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
          privacy
        </h1>
        <p
          className="hand"
          style={{ color: "var(--ink-soft)", fontSize: 14, margin: "0 0 32px" }}
        >
          Last updated: May 5, 2026
        </p>

        <Section title="What Verdant collects">
          When you sign in with Google, we receive your name, email address, and
          profile photo. If you connect Google Calendar, we read your free/busy
          windows and write events for the sessions Verdant schedules — nothing
          else. We store the learning plans, journal entries, and ratings you
          create inside the app.
        </Section>

        <Section title="How we use it">
          To generate, schedule, and adapt your learning plan. Plan content
          (your goal, deadline, and starter resources) is sent to OpenAI to
          draft and refine plans; OpenAI does not train on this data per their
          API policy. We do not sell or share your data with anyone else.
        </Section>

        <Section title="Where it lives">
          Your data lives in a Postgres database hosted by Neon and is served
          through Vercel. Both providers operate in the United States.
        </Section>

        <Section title="Your choices">
          You can disconnect Google Calendar at any time in Settings. To delete
          your account and all associated data, email the address below and we
          will remove it within 7 days.
        </Section>

        <Section title="Contact">
          Questions or deletion requests:{" "}
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
