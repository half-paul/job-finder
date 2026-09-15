"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { api } from "./client";
import { Button } from "./ui/button";

type EvaluationResult = {
  match: {
    overallScore: number;
    qualificationScore: number;
    interestScore: number;
    confidence: string;
  } | null;
  blocked: { passed: boolean; reason: string } | null;
};

export function MatchEvaluator({
  jobId,
  evaluated,
}: {
  jobId: string;
  evaluated: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function evaluate() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<EvaluationResult>(
        `jobs/${jobId}/evaluate`,
        "POST",
      );
      if (result.match) setMessage("Evaluation complete.");
      else if (result.blocked)
        setMessage(`Hard requirement not met: ${result.blocked.reason}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="match-evaluator">
      <Button disabled={busy} onClick={() => void evaluate()}>
        <Sparkles size={17} />
        {busy
          ? "Evaluating…"
          : evaluated
            ? "Re-evaluate match"
            : "Evaluate match"}
      </Button>
      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
