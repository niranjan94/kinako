import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";
import {
  FORK_DISPLAY_NAME,
  FORK_MARK_BRANCH_PATH,
  FORK_MARK_STEM_PATH,
  FORK_MARK_VIEWBOX,
} from "@t3tools/shared/forkBrand";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel={FORK_DISPLAY_NAME}
      height={props.height}
      width={props.height}
      viewBox={FORK_MARK_VIEWBOX}
    >
      <ThemedPath
        d={`${FORK_MARK_STEM_PATH} ${FORK_MARK_BRANCH_PATH}`}
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
