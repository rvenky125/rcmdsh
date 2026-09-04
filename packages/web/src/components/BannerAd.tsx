import { useEffect } from "react";
import { BANNER_SRC, reloadExternalScript } from "../lib/ads";

const CONTAINER_ID = "container-4b7610120382ddb30f7aadbd0b8e2a42";

export function BannerAd() {
  useEffect(() => {
    reloadExternalScript(BANNER_SRC, "banner-invoke-js", { "data-cfasync": "false" });
    return () => {
      document.getElementById("banner-invoke-js")?.remove();
    };
  }, []);

  return (
    <div className="banner-ad">
      <div id={CONTAINER_ID} />
    </div>
  );
}
