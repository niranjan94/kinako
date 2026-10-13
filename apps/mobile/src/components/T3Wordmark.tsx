import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * The brand mark, matching the desktop sidebar's T3Wordmark SVG
 * (apps/web Sidebar.tsx). Width derives from the viewBox aspect ratio.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 1;
  return (
    <Svg
      accessibilityLabel="Kinako"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="15.5 20.5 92 92"
    >
      <ThemedPath
        d="M21.47 111.47L33.89 99.06A14 14 0 0 0 53.06 79.89L56.89 76.06A14 14 0 0 0 76.06 56.89L79.89 53.06A14 14 0 0 0 99.06 33.89L106.47 26.47A3.5 3.5 0 0 0 101.53 21.53L94.11 28.94A14 14 0 0 0 74.94 48.11L71.11 51.94A14 14 0 0 0 51.94 71.11L48.11 74.94A14 14 0 0 0 28.94 94.11L16.53 106.53A3.5 3.5 0 0 0 21.47 111.47Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
