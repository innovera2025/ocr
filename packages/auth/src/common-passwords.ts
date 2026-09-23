/**
 * Small bundled password denylist (plan §4 B1). Entries are lower-case and compared for equality against the
 * NFKC-normalized, lower-cased password, so an entry shorter than the 12 code-point minimum can never match on its
 * own; the short context words are kept because they document what the list is for and because the minimum may move.
 * Nothing here is a credential: it is the public "most common passwords" set plus words from this deployment.
 */
const ENTRIES: readonly string[] = [
  // Context words for this deployment.
  "makkha", "makkhahealth", "makkhahealthspa", "makkhaspa", "makkhaspa2026", "makkha123456", "makkha1234567890",
  "innovera", "innoveraocr", "innovera2026", "innovera123456", "innoveraappcenter",
  "spa", "spamassage", "spa123456789", "massage", "massage123456", "massagespa123",
  "admin", "administrator", "adminadmin", "admin1234567", "administrator1", "adminpassword",
  "password", "password1", "password12", "password123", "password1234", "password12345", "password123456",
  "passw0rd", "passw0rd123", "p@ssword123", "p@ssw0rd123", "passwordpassword",
  "ocr", "ocrocrocrocr", "ocr123456789", "innoveraocr123", "makkhaocr1234",
  // Most common passwords (public breach lists).
  "123456", "123456789", "12345678", "1234567890", "12345678910", "123456789012", "1234567891011",
  "111111", "1111111111", "111111111111", "000000", "0000000000", "000000000000",
  "112233", "121212", "123123", "123123123", "123321", "654321", "666666", "696969", "777777", "888888", "999999",
  "1q2w3e4r", "1q2w3e4r5t", "1qaz2wsx", "1qaz2wsx3edc", "qazwsxedcrfv", "zaq12wsx", "qwerty", "qwerty123",
  "qwerty123456", "qwertyuiop", "qwertyuiop123", "qwertyuiopasdfgh", "asdfghjkl", "asdfghjkl123", "zxcvbnm",
  "zxcvbnm123456", "qweasdzxc123", "abc123", "abc123456", "abcd1234", "abcdefghijkl", "abcdefg123456",
  "a1b2c3d4e5f6", "aaaaaaaaaaaa", "letmein", "letmein123456", "welcome", "welcome123", "welcome1234",
  "welcome123456", "iloveyou", "iloveyou123", "iloveyou1234", "iloveyouforever", "trustno1", "trustnoone1",
  "monkey", "monkey123456", "dragon", "dragon123456", "master", "master123456", "shadow", "shadow123456",
  "sunshine", "sunshine123", "princess", "princess123", "football", "football1234", "baseball", "baseball1234",
  "superman", "superman1234", "batman123456", "pokemon123456", "starwars12345", "jordan23jordan",
  "michael123456", "jennifer12345", "jessica123456", "charlie123456", "thomas1234567", "daniel1234567",
  "andrew1234567", "joshua1234567", "matthew123456", "nicole1234567", "hunter1234567", "harley1234567",
  "buster1234567", "cookie1234567", "pepper1234567", "ginger1234567", "peanut1234567", "chicken123456",
  "computer12345", "internet12345", "whatever12345", "freedom123456", "hello123456", "helloworld123",
  "goodluck12345", "changeme", "changeme123", "changeme1234", "changemenow12", "temppassword", "temppassword1",
  "temporary1234", "newpassword12", "newpassword123", "defaultpass12", "default123456", "secret1234567",
  "secretpassword", "nopassword123", "mypassword123", "mypassword1234", "thisismypassword", "passwordisgood",
  "letmeinplease", "openthedoor12", "access1234567", "accesscode123", "login1234567", "loginpassword",
  "iamthebest123", "nevergiveup12", "keepitsimple1", "sunshine12345", "moonlight1234", "starlight1234",
  "summer2026abc", "winter2026abc", "spring2026abc", "autumn2026abc", "january123456", "december12345",
  "bangkok123456", "thailand12345", "chiangmai1234", "phuket1234567", "sawasdee12345", "sawasdeekrub1",
  "sawasdeekrap1", "thailand2026a", "bangkok2026ab", "siamparagon12", "sukhumvit1234",
  "asdf1234asdf", "asdfasdfasdf", "qwerqwerqwer", "zxcvzxcvzxcv", "poiuytrewq12", "lkjhgfdsa123",
  "mnbvcxz12345", "0987654321ab", "9876543210ab", "147258369abc", "159753456abc", "753951456abc",
  "11223344556", "1122334455667", "10203040506", "102030405060", "13579246810", "24681357910",
  "qwerty12345678", "passwordqwerty", "adminqwerty123", "rootpassword1", "rootroot12345", "toor12345678",
  "guestguest123", "userpassword1", "usernamepass1", "testtest12345", "test1234test", "testpassword1",
  "demopassword1", "samplepass123", "examplepass12", "dummypassword", "placeholder12"
];

/** Frozen membership set; `checkPasswordPolicy` does an exact lookup. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(ENTRIES);
