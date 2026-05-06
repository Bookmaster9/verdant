import { auth } from "@/auth";
import { ensureUserPreferences } from "@/lib/user";
import { PrimaryNav } from "./verdant/PrimaryNav";
import { PlantHelper } from "./verdant/PlantHelper";
import { FooterStrip } from "./verdant/FooterStrip";

export async function Shell({
  children,
  showHelper = true,
  showFooter = true,
}: {
  children: React.ReactNode;
  showHelper?: boolean;
  showFooter?: boolean;
}) {
  const session = await auth();
  const user = session?.user
    ? { name: session.user.name, email: session.user.email, image: session.user.image }
    : null;
  const signedIn = Boolean(session);
  const pushToCalendar = signedIn && session?.user?.id
    ? (await ensureUserPreferences(session.user.id)).pushToCalendar
    : false;
  return (
    <div className="app-frame">
      <PrimaryNav signedIn={signedIn} user={user} pushToCalendar={pushToCalendar} />
      <main>{children}</main>
      {signedIn && showFooter && <FooterStrip />}
      {signedIn && showHelper && <PlantHelper />}
    </div>
  );
}
