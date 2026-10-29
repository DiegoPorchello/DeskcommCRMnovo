"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { invalidarSessao, invalidarUsuario, sessaoDosCookies } from "@/lib/auth/cache-curto";
import { audit } from "@/lib/audit";
import { encerrarPushDeTodosOsAparelhos } from "@/lib/notifications/encerrar-push-de-todos-os-aparelhos";

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");

  // `signOut()` sem `scope` é `global` no auth-js: desconecta TODOS os
  // aparelhos da pessoa. Os avisos acompanham a sessão — senão um aparelho já
  // deslogado segue recebendo push da empresa.
  if (user) await encerrarPushDeTodosOsAparelhos(user.id, requestId);

  const sessao = sessaoDosCookies((await cookies()).getAll());
  await supabase.auth.signOut();

  // #3696: saída é revogação. O token pode continuar no cookie de outra aba, e
  // o cache curto não pode devolver esta sessão depois do signOut.
  if (user) invalidarUsuario(user.id);
  if (sessao) invalidarSessao(sessao.chave);

  // Clear active_org cookie too.
  const store = await cookies();
  store.delete("active_org");

  if (user) {
    await audit({
      action: "auth.logout",
      actorUserId: user.id,
      requestId,
      ip: ipDoCliente(hdrs),
      userAgent: hdrs.get("user-agent") ?? null,
      metadata: { scope: "global" },
    });
  }

  redirect("/login");
}
