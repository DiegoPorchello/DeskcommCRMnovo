/**
 * O lembrete de agendamento escolhe o canal do CONTATO (#2594).
 *
 * Antes, o cron pegava o primeiro canal `WORKING` da organização, sem ordem —
 * numa org com Instagram e WhatsApp, o lembrete saía por um canal imprevisível.
 * Agora: com telefone, canal de telefone (WhatsApp); sem telefone, canal social.
 *
 * O último caso importa tanto quanto os outros dois: sem a informação do
 * telefone, o comportamento antigo (ambíguo com mais de um elegível) tem de
 * continuar — não se inventa preferência com dado que não existe.
 */
import { describe, expect, it } from "vitest";

import { decidirRemetenteDoLembrete, type CanalDoLembrete } from "./remetente-do-lembrete";

const agora = new Date("2026-10-29T12:00:00Z");
const ha10min = new Date("2026-10-29T11:50:00Z").toISOString();

function canal(id: string, provider: string): CanalDoLembrete {
  return {
    id,
    provider,
    status: "WORKING",
    archived_at: null,
    metadata: null,
    lastInboundAt: ha10min,
  };
}

const whatsapp = canal("c-whats", "waha");
const instagram = canal("c-insta", "zernio_social");

describe("lembrete escolhe o canal do contato (#2594)", () => {
  it("com telefone, escolhe o canal de telefone (WhatsApp) mesmo com social elegível", () => {
    const r = decidirRemetenteDoLembrete([instagram, whatsapp], null, agora, "5541999999999");
    expect(r.canal?.id).toBe("c-whats");
    expect(r.motivo).toBeNull();
  });

  it("sem telefone, escolhe o canal social", () => {
    const r = decidirRemetenteDoLembrete([whatsapp, instagram], null, agora, null);
    expect(r.canal?.id).toBe("c-insta");
  });

  it("sem a informação do telefone, mantém o comportamento anterior (ambíguo)", () => {
    const r = decidirRemetenteDoLembrete([whatsapp, instagram], null, agora);
    expect(r.canal).toBeNull();
    expect(r.motivo).toBe("remetente_ambiguo");
  });

  it("o vínculo indicado continua sendo autoridade sobre a preferência", () => {
    const r = decidirRemetenteDoLembrete([instagram, whatsapp], "c-insta", agora, "5541999999999");
    expect(r.canal?.id).toBe("c-insta");
  });
});
