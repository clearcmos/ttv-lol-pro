import { Address4, Address6 } from "ip-address";
import { getProxyInfoFromUrl } from "./proxyInfo";

const ip4LinkLocalSubnet = new Address4("169.254.0.0/16");
const ip4LoopbackSubnet = new Address4("127.0.0.0/8");
const ip4PrivateASubnet = new Address4("10.0.0.0/8");
const ip4PrivateBSubnet = new Address4("172.16.0.0/12");
const ip4PrivateCSubnet = new Address4("192.168.0.0/16");

/**
 * Check if an IP address is private (link-local, loopback, or private range).
 * @param ip
 * @returns
 */
export function isPrivateIpAddress(ip: string): boolean {
  try {
    const ip4 = new Address4(ip);
    return (
      ip4.isInSubnet(ip4LinkLocalSubnet) ||
      ip4.isInSubnet(ip4LoopbackSubnet) ||
      ip4.isInSubnet(ip4PrivateASubnet) ||
      ip4.isInSubnet(ip4PrivateBSubnet) ||
      ip4.isInSubnet(ip4PrivateCSubnet)
    );
  } catch (error) {}

  try {
    const ip6 = new Address6(ip);
    return ip6.isLinkLocal() || ip6.isLoopback();
  } catch (error) {}

  return false;
}

/**
 * Normalize an IP address to its canonical form.
 * @param ip
 * @returns
 */
export function normalizeIpAddress(ip: string): string | null {
  try {
    if (Address4.isValid(ip)) {
      return new Address4(ip).correctForm();
    }
    if (Address6.isValid(ip)) {
      const addr6 = new Address6(ip);
      // Handle IPv4-mapped IPv6 (::ffff:192.0.2.128)
      if (addr6.is4()) {
        return addr6.to4().correctForm();
      }
      return addr6.correctForm();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Anonymize an IP address by masking the last 2 octets of an IPv4 address
 * or the last 8 octets of an IPv6 address.
 * @param url
 * @returns
 */
export function anonymizeIpAddress(url: string): string {
  const proxyInfo = getProxyInfoFromUrl(url);

  let proxyHost = proxyInfo.host;

  const isIPv4 = Address4.isValid(proxyHost);
  const isIPv6 = Address6.isValid(proxyHost);
  const isIP = isIPv4 || isIPv6;
  const isPublicIP = isIP && !isPrivateIpAddress(proxyHost);

  if (isPublicIP) {
    if (isIPv4) {
      proxyHost = new Address4(proxyHost)
        .correctForm()
        .split(".")
        .map((byte, index) => (index < 2 ? byte : "xxx"))
        .join(".");
    } else if (isIPv6) {
      const bytes = new Address6(proxyHost).toByteArray();
      const anonymizedBytes = bytes.map((byte, index) =>
        index < 6 ? byte : 0x0
      );
      proxyHost = Address6.fromByteArray(anonymizedBytes)
        .correctForm()
        .replace(/::$/, "::xxxx");
    }
  }

  return proxyHost; // Anonymize port by removing it.
}

/**
 * Anonymize an array of IP addresses. See {@link anonymizeIpAddress}.
 * @param urls
 * @returns
 */
export function anonymizeIpAddresses(urls: string[]): string[] {
  return urls.map(url => anonymizeIpAddress(url));
}
