import { GardenStrip } from "./art";

export function FooterStrip() {
  return (
    <div style={{ marginTop: 36, paddingTop: 24, position: "relative" }}>
      <GardenStrip height={70} />
      <div
        style={{
          textAlign: "center",
          marginTop: 8,
          fontFamily: "var(--font-fraunces)",
          fontStyle: "italic",
          fontSize: 14,
          color: "var(--ink-faded)",
        }}
      >
        tend gently, grow patiently
      </div>
    </div>
  );
}
