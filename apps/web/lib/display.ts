export function salary(job: {
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string;
}) {
  if (job.salaryMin === null && job.salaryMax === null)
    return "Salary not listed";
  const currency = /^[a-z]{3}$/i.test(job.currency)
    ? job.currency.toUpperCase()
    : null;
  const formatter = new Intl.NumberFormat("en", {
    ...(currency ? { style: "currency", currency } : { style: "decimal" }),
    maximumFractionDigits: 0,
    notation: "compact",
  });
  const fmt = (value: number) => formatter.format(value);
  return `${job.salaryMin === null ? "Up to " : fmt(job.salaryMin)}${job.salaryMin !== null && job.salaryMax !== null ? " – " : ""}${job.salaryMax !== null ? fmt(job.salaryMax) : "+"} ${currency ?? "(currency unknown)"}`;
}
