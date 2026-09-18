import { z } from "zod";
import { jobInputSchema } from "@jobfinder/shared";
import {
  descriptionDigest,
  fetchJson,
  htmlToText,
  isoDate,
  type ConnectorOptions,
  type SourceConnector,
} from "../index";

const reference = z.object({
  uuid: z.string().min(1),
  name: z.string().min(1),
  url: z.url(),
});

const detail = reference.extend({
  description: z
    .object({
      company: z.string().nullable().optional().default(""),
      role: z.string().nullable().optional().default(""),
    })
    .nullable()
    .optional(),
  companyName: z.string().nullable().optional().default(""),
  employmentType: z
    .object({
      id: z.string().nullable().optional().default(""),
      label: z.string().nullable().optional().default(""),
    })
    .nullable()
    .optional(),
  department: z
    .object({ label: z.string().nullable().optional().default("") })
    .nullable()
    .optional(),
  workLocations: z.array(z.string()).nullable().optional().default([]),
  createdOn: z.string().nullable().optional(),
});

const boardUrl = (board: string) =>
  `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(board)}/jobs`;

const employmentType = (value: string) => {
  const kind = value.toLowerCase();
  if (/contract|freelance|temp/.test(kind)) return "Contract";
  if (/salaried|full[ -_]?time|ft\b/.test(kind)) return "Full-time";
  if (/part[ -_]?time|intern|pt\b/.test(kind)) return "Temporary";
  return "Unknown";
};

export function createRipplingConnector(
  options: ConnectorOptions = {},
): SourceConnector<z.infer<typeof detail>> {
  return {
    name: "Rippling",
    async search(query, _cursor, signal) {
      if (!query.board) throw new Error("Rippling board slug is required");
      const response = await fetchJson(new URL(boardUrl(query.board)), {
        ...options,
        signal,
      });
      const items = z.array(z.unknown()).parse(response.data);
      const jobs: z.infer<typeof reference>[] = [];
      for (const item of items) {
        const parsed = reference.safeParse(item);
        if (parsed.success) jobs.push(parsed.data);
      }
      return {
        jobs: jobs.map((job) => ({
          externalId: job.uuid,
          url: job.url,
          board: query.board,
          company: query.company,
        })),
        // The board endpoint takes no paging parameters and returns every
        // posting in one response, so this is the employer's full inventory and
        // missing listings may be marked removed. If Rippling ever paginates,
        // this must return `canMarkRemovals: false` instead: a truncated read
        // would otherwise deactivate every listing it did not see.
        canMarkRemovals: true,
        complete: true,
        notModified: false,
      };
    },
    async fetchJob(reference, signal) {
      if (!reference.board) throw new Error("Rippling board slug is required");
      const url = new URL(
        `${boardUrl(reference.board)}/${encodeURIComponent(reference.externalId)}`,
      );
      const response = await fetchJson(url, { ...options, signal });
      return detail.parse(response.data);
    },
    async normalize(raw, context) {
      // The role body carries the posting; the company blurb repeats on every
      // listing, so it trails the role rather than leading the description.
      const description = htmlToText(
        [raw.description?.role, raw.description?.company]
          .filter(Boolean)
          .join("\n\n"),
      );
      const location = (raw.workLocations ?? []).filter(Boolean).join("; ");
      const input = jobInputSchema.parse({
        title: htmlToText(raw.name),
        company:
          htmlToText(raw.companyName ?? "") ||
          context.query.company ||
          context.query.board,
        description,
        location: location.slice(0, 200),
        country: "",
        industry: (raw.department?.label ?? "").slice(0, 200),
        employmentType: employmentType(
          `${raw.employmentType?.id ?? ""} ${raw.employmentType?.label ?? ""}`,
        ),
        seniority: "Unknown",
        workType: /remote/i.test(location)
          ? "Remote"
          : location
            ? "On-site"
            : "Unknown",
        // payRangeDetails exists on the schema but was empty on every posting
        // sampled, so its shape is unverified and no salary is claimed.
        salaryMin: null,
        salaryMax: null,
        salaryPeriod: "unknown",
        currency: "Unknown",
        jobUrl: raw.url,
        postedAt: isoDate(raw.createdOn),
      });
      return {
        ...input,
        externalId: raw.uuid,
        provider: "Rippling" as const,
        sourceUrl: raw.url,
        descriptionHash: descriptionDigest(description),
      };
    },
  };
}
