export function salary(job: {
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string;
}) {
  if (job.salaryMin === null && job.salaryMax === null)
    return "Salary not listed";
  const fmt = (v: number) =>
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: job.currency,
      maximumFractionDigits: 0,
      notation: "compact",
    }).format(v);
  return `${job.salaryMin === null ? "Up to " : fmt(job.salaryMin)}${job.salaryMin !== null && job.salaryMax !== null ? " – " : ""}${job.salaryMax !== null ? fmt(job.salaryMax) : "+"} ${job.currency}`;
}
