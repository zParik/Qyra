import { useState } from "react";
import { Signature } from "../SignatureLayer";

/**
 * E-signature placement state — the list of placed signatures, the pending
 * signature awaiting drop, and the signature-creation panel visibility.
 */
export function useSignatures() {
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  const [showSignaturePanel, setShowSignaturePanel] = useState<boolean>(false);

  return {
    signatures,
    setSignatures,
    pendingSignature,
    setPendingSignature,
    showSignaturePanel,
    setShowSignaturePanel,
  };
}
