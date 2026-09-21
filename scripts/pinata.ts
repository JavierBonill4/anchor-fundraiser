export async function pinJsonToPinata(args: {
  jwt: string;
  name: string;
  body: unknown;
}): Promise<string> {
  const file = new File(
    [JSON.stringify(args.body)],
    `${args.name}.json`,
    { type: "application/json" },
  );
  const form = new FormData();
  form.append("file", file);
  form.append("name", args.name);
  form.append("network", "public");

  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.jwt}` },
    body: form,
  });
  if (!res.ok)
    throw new Error(`Pinata pin failed (${res.status}): ${await res.text()}`);

  const data = (await res.json()) as { data?: { cid?: string }; cid?: string };
  const cid = data.data?.cid ?? data.cid;
  if (!cid) throw new Error("Pinata response missing cid");
  return cid;
}
