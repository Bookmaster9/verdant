import { auth } from "@/auth";
import { Shell } from "@/components/Shell";
import { GoogleSignIn } from "./sign-in";
import { redirect } from "next/navigation";
import { Sprout } from "@/components/verdant/art";
import { SectionTitle } from "@/components/verdant/SectionTitle";

export default async function LoginPage() {
  const s = await auth();
  if (s?.user) {
    redirect("/dashboard");
  }
  const hasGoogle = Boolean(
    process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
  );
  return (
    <Shell showHelper={false} showFooter={false}>
      <div style={{ padding: "20px 36px 60px", display: "grid", placeItems: "center" }}>
        <div className="ink-card" style={{ width: 480, padding: 40, position: "relative" }}>
          <div
            className="tape"
            style={{ left: "50%", marginLeft: -39, top: -10, transform: "rotate(-3deg)" }}
          />
          <div style={{ display: "grid", placeItems: "center", marginBottom: 14 }}>
            <Sprout size={120} growth={0.85} />
          </div>
          <SectionTitle kicker="welcome" align="center">
            Open the journal
          </SectionTitle>
          <p
            style={{
              textAlign: "center",
              color: "var(--ink-soft)",
              fontSize: 15,
              lineHeight: 1.5,
              margin: "0 0 22px",
            }}
          >
            We use Google so we can place practice into your calendar gently. We only touch
            events tagged with a sprout.
          </p>
          {!hasGoogle && (
            <div
              className="ink-card soft"
              style={{
                background: "var(--sun-soft)",
                padding: 12,
                marginBottom: 14,
                fontSize: 13,
                lineHeight: 1.4,
              }}
            >
              Set <code>AUTH_GOOGLE_ID</code> and <code>AUTH_GOOGLE_SECRET</code> in{" "}
              <code>.env</code> to enable Google sign-in.
            </div>
          )}
          <GoogleSignIn disabled={!hasGoogle} />
          <p
            style={{
              fontFamily: "var(--font-fraunces)",
              fontStyle: "italic",
              textAlign: "center",
              marginTop: 18,
              fontSize: 13,
              color: "var(--ink-faded)",
            }}
          >
            we&apos;ll never plant something without asking first.
          </p>
        </div>
      </div>
    </Shell>
  );
}
