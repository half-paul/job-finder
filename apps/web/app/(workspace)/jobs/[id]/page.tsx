import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import {
  ArrowLeft,
  ArrowUpRight,
  MapPin,
  BriefcaseBusiness,
} from "lucide-react";
import { pageUser } from "../../../../lib/auth";
import { getJob } from "../../../../lib/jobs";
import { HttpError } from "../../../../lib/http";
import { salary } from "../../../../lib/display";
import { JobActions } from "../../../../components/job-actions";
import { Button } from "../../../../components/ui/button";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await pageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const result = await getJob(user.id, id).catch((error) => {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  });
  const { job, match, state, history } = result;
  return (
    <>
      <Link className="back-link" href="/jobs">
        <ArrowLeft size={16} />
        All opportunities
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{job.company}</span>
          <h1>{job.title}</h1>
          <p className="job-meta">
            <MapPin size={16} />
            {job.location || "Location not listed"} · {job.workType}
            <BriefcaseBusiness size={16} />
            {job.employmentType}
          </p>
        </div>
        <Button asChild>
          <a href={job.jobUrl} target="_blank" rel="noopener noreferrer">
            Original listing
            <ArrowUpRight size={17} />
          </a>
        </Button>
      </div>
      <div className="detail-layout">
        <div>
          <section className="panel form-panel">
            <div className="detail-facts">
              <div>
                <small>COMPENSATION</small>
                <strong>{salary(job)}</strong>
              </div>
              <div>
                <small>SENIORITY</small>
                <strong>{job.seniority}</strong>
              </div>
              <div>
                <small>SOURCE</small>
                <strong>{job.source}</strong>
              </div>
            </div>
            <h2>About the opportunity</h2>
            <div className="job-description">{job.description}</div>
          </section>
          <section className="panel form-panel">
            <h2>Your match</h2>
            {match ? (
              <>
                <div className="match-scores">
                  <div>
                    <strong>{match.overallScore}</strong>Overall
                  </div>
                  <div>
                    <strong>{match.qualificationScore}</strong>Qualifications
                  </div>
                  <div>
                    <strong>{match.interestScore}</strong>Interest
                  </div>
                </div>
                <p>Confidence: {match.confidence}</p>
                <h3>Why it matches</h3>
                <ul>
                  {match.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <h3>Possible gaps</h3>
                <ul>
                  {match.gaps.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <p>{match.progression}</p>
              </>
            ) : (
              <p className="muted">
                This opportunity has not been evaluated. Semantic matching and
                explainable scores will be available in Phase 3.
              </p>
            )}
          </section>
        </div>
        <aside>
          <section className="panel form-panel">
            <h2>Make your next move</h2>
            <JobActions
              id={id}
              status={state?.status ?? "Discovered"}
              notes={state?.notes ?? ""}
            />
          </section>
          <section className="panel form-panel">
            <h2>Opportunity timeline</h2>
            <ol className="timeline">
              {history.map((h) => (
                <li key={h.id}>
                  <strong>{h.status}</strong>
                  <span>
                    {h.createdAt.toLocaleDateString("en-CA", {
                      timeZone: "UTC",
                    })}
                  </span>
                </li>
              ))}
              <li>
                <strong>Discovered</strong>
                <span>
                  {job.discoveredAt.toLocaleDateString("en-CA", {
                    timeZone: "UTC",
                  })}
                </span>
              </li>
              {job.postedAt && (
                <li>
                  <strong>Posted</strong>
                  <span>
                    {job.postedAt.toLocaleDateString("en-CA", {
                      timeZone: "UTC",
                    })}
                  </span>
                </li>
              )}
            </ol>
            <p className="muted">Listing status: {job.lifecycle}</p>
          </section>
        </aside>
      </div>
    </>
  );
}
