import Link from "next/link";
export default function NotFound() {
  return (
    <main className="standalone-error">
      <h1>This page isn’t here.</h1>
      <p>The opportunity may be unavailable or belong to another workspace.</p>
      <Link className="button button-primary" href="/">
        Back to overview
      </Link>
    </main>
  );
}
