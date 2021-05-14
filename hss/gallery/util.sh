downsize() {
  local file=$1;
  local name=${file%.*};
  ffmpeg -i $file $name.jpg;
  ffmpeg -i $file -vf scale=256:-1 $name.xs.jpg;
}
