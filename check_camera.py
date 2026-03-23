import cv2
cap = cv2.VideoCapture(1)
print('opened:', cap.isOpened())
ok, frame = cap.read()
print('read ok:', ok, 'shape:', frame.shape if ok else 'N/A')
cap.release()
