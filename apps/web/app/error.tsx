"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="standalone-error">
      <h1>We couldn’t load your workspace.</h1>
      <p>Check that the database is running, then try again.</p>
      <button className="button button-primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
