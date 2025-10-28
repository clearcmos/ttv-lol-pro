export default function generateRandomString(length: number) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomArray = new Uint8Array(length);
  crypto.getRandomValues(randomArray);
  let result = "";
  randomArray.forEach(number => {
    result += chars[number % chars.length];
  });
  return result;
}
