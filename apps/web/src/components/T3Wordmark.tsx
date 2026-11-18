import type { SVGProps } from "react";
import {
  FORK_MARK_BRANCH_PATH,
  FORK_MARK_STEM_PATH,
  FORK_MARK_VIEWBOX,
} from "@t3tools/shared/forkBrand";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox={FORK_MARK_VIEWBOX} xmlns="http://www.w3.org/2000/svg">
      <path d={`${FORK_MARK_STEM_PATH} ${FORK_MARK_BRANCH_PATH}`} fill="currentColor" />
    </svg>
  );
}
